import { Actor, RequestQueue, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import type { PlaywrightCrawlingContext, RequestOptions, AutoscaledPoolOptions } from 'crawlee';
import { MemoryStorage } from '@crawlee/memory-storage';
import { ServerResponse } from 'http';
import { TimeMeasure, UserData, VerboseResult, CrawlerOptions } from './types.js';
import { addResponse, sendErrorResponseById } from './responses.js';
import { router } from './router.js';
import { pushLogData } from './utils.js';
import { Label } from './const.js';

const crawlers = new Map<string, PlaywrightCrawler>();

export const DEFAULT_CRAWLER_OPTIONS: CrawlerOptions = {
    proxyConfigurationOptions: {},
};

export const createAndStartCrawler = async (crawlerOptions: CrawlerOptions = DEFAULT_CRAWLER_OPTIONS) => {
    log.info(`Creating and starting crawler with options: ${JSON.stringify(crawlerOptions, null, 2)}`);
    const client = new MemoryStorage();
    const queue = await RequestQueue.open(undefined, { storageClient: client });

    const proxyConfig = await Actor.createProxyConfiguration(crawlerOptions.proxyConfigurationOptions);

    const crawler = new PlaywrightCrawler({
        keepAlive: true,
        proxyConfiguration: proxyConfig,
        maxRequestRetries: 1,
        maxConcurrency: 1,
        requestQueue: queue,
        useSessionPool: true,
        // retryOnBlocked: true,
        launchContext: {
            browserPerProxy: false,  // maybe change this to true
            // useIncognitoPages: true,  // maybe true will help -- seems like??
        },
        // browserPoolOptions: {
        //     useFingerprints: true,  // defaults to true anyway
        //     fingerprintOptions: {
        //         useFingerprintCache: true,  // might already default to true
        //     },
        // },
        statisticsOptions: {
            persistenceOptions: {
                enable: false,
            },
        },
        requestHandlerTimeoutSecs: 3600,
        sessionPoolOptions: {
            persistenceOptions: {
                enable: false,
            },
            sessionOptions: {
                maxErrorScore: 1,
            },
        },
        errorHandler: async ({ request }, err) => {
            const { requestDetails, timeMeasures, transparentStatusCode } = request.userData as UserData;
            timeMeasures.push({
                event: 'error',
                time: Date.now(),
            });

            requestDetails.requestErrors.push({
                attempt: request.retryCount + 1,
                errorMessage: err.message,
            });

        },
        failedRequestHandler: async ({ request, response, page }, err) => {
            const {
                requestDetails,
                jsonResponse,
                inputtedUrl,
                parsedInputtedParams,
                timeMeasures,
                transparentStatusCode,
                nonbrowserRequestStatus,
            } = request.userData as UserData;

            requestDetails.requestErrors.push({
                attempt: request.retryCount + 1,
                errorMessage: err.message,
            });

            const errorResponse = {
                errorMessage: err.message,
            };

            const responseStatusCode = request.skipNavigation ? nonbrowserRequestStatus! : (response?.status() || null);
            let statusCode = 500;
            if (transparentStatusCode && responseStatusCode) {
                statusCode = responseStatusCode;
            }
            if (jsonResponse) {
                const verboseResponse: VerboseResult = {
                    body: errorResponse,
                    cookies: await page.context().cookies(request.url) || [],
                    evaluateResults: [],
                    jsScenarioReport: {},
                    headers: requestDetails.responseHeaders || {},
                    type: 'json',
                    iframes: [],
                    xhr: [],
                    initialStatusCode: responseStatusCode,
                    resolvedUrl: '',
                    screenshot: null,
                };
                await pushLogData(timeMeasures, { inputtedUrl, parsedInputtedParams, result: verboseResponse, errors: requestDetails.requestErrors }, true);
                sendErrorResponseById(request.uniqueKey, JSON.stringify(verboseResponse), statusCode);
            } else {
                await pushLogData(timeMeasures, { inputtedUrl, parsedInputtedParams, result: errorResponse, errors: requestDetails.requestErrors }, true);
                sendErrorResponseById(request.uniqueKey, JSON.stringify(errorResponse), statusCode);
            }
        },
        preNavigationHooks: [
            async ({ page }) => {
                page.on('response', (resp) => console.log(`${resp.url()} (${resp.request().resourceType()}) : ${resp.status()}`))
            },
            async ({ request, page, blockRequests, browserController, proxyInfo }) => {
                log.debug('preNavigationHook entered.');
                log.debug(`Browser has ${browserController.activePages} active pages.`);
                if (proxyInfo) {
                  log.info(`ProxyInfo - url: ${proxyInfo.url}, hostname: ${proxyInfo.hostname}, proxyTier: ${proxyInfo.proxyTier}`);
                }
                const { timeMeasures, blockResources, width, height, blockResourcePatterns, jsonResponse, requestDetails } = request.userData as UserData;
                timeMeasures.push({
                    event: 'pre-navigation hook',
                    time: Date.now(),
                });

                await page.setViewportSize({ width, height });

                if (request.label === Label.BROWSER && blockResources) {
                    await blockRequests({
                        extraUrlPatterns: blockResourcePatterns || [],
                    });
                }

                if (request.label === Label.BROWSER && jsonResponse) {
                    page.on('response', async (resp) => {
                        try {
                            const req = resp.request();
                            if (req.resourceType() !== 'xhr') {
                                return;
                            }

                            requestDetails.xhr.push({
                                url: req.url(),
                                statusCode: resp.status(),
                                method: req.method(),
                                requestHeaders: req.headers(),
                                headers: resp.headers(),
                                body: (await resp.body()).toString(),
                            });
                        } catch (e) {
                            log.warning((e as Error).message);
                        }
                    });
                }
            },
        ],
        requestHandler: router,
    });

    // TODO: This is just for Crawlee perf measurement, remove it once we properly understand the bottlenecks
    // @ts-expect-error Overriding internal method
    const origRunTaskFunction = crawler.autoscaledPoolOptions.runTaskFunction.bind(crawler);
    // @ts-expect-error Overriding internal method
    crawler.autoscaledPoolOptions.runTaskFunction = async function () {
        // This code runs before we pull request from queue so we have to approximate that by having mutable global
        // It will ofc be wrong if someone bombs requests with interval shorter than 1 sec
        (global as unknown as { latestRequestTaskTimeMeasure: TimeMeasure }).latestRequestTaskTimeMeasure = {
            event: 'crawlee internal run task',
            time: Date.now(),
        };
        await (origRunTaskFunction as AutoscaledPoolOptions['runTaskFunction'])!();
    };

    // @ts-expect-error Overriding internal method
    const origRunRequestHandler = crawler._runRequestHandler.bind(crawler);
    // @ts-expect-error Overriding internal method
    crawler._runRequestHandler = async function (context: PlaywrightCrawlingContext<UserData>) {
        context.request.userData.timeMeasures.push({
            event: 'crawlee internal request handler',
            time: Date.now(),
        });
        await origRunRequestHandler(context);
    };

    await crawler.stats.stopCapturing();
    crawler.run().then(() => log.warning(`Crawler ended`, crawlerOptions), () => { });
    crawlers.set(JSON.stringify(crawlerOptions), crawler);
    log.info('Opening separate blank page to keep browser alive.');
    crawler.browserPool.newPage();
    log.info('Crawler ready 🫡', crawlerOptions);
    return crawler;
};

export const addRequest = async (request: RequestOptions<UserData>, res: ServerResponse, crawlerOptions: CrawlerOptions) => {
    const key = JSON.stringify(crawlerOptions);
    log.info(`Looking for crawler with options matching: ${key}`);
    const crawler = crawlers.has(key) ? crawlers.get(key)! : await createAndStartCrawler(crawlerOptions);

    addResponse(request.uniqueKey!, res);

    request.userData?.timeMeasures.push({
        event: 'before queue add',
        time: Date.now(),
    });
    await crawler.requestQueue!.addRequest(request);
};
