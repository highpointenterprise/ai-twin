import { HttpsProxyAgent } from "https-proxy-agent";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
// Keep the managed environment's proxy and CA trust; never disable TLS checks.
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)
  setGlobalDispatcher(new EnvHttpProxyAgent());

let cached: { proxy: string; agent: HttpsProxyAgent<string> } | undefined;

export const providerAgent = (): HttpsProxyAgent<string> | undefined => {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY;
  if (!proxy) return undefined;
  if (cached?.proxy !== proxy)
    cached = {
      proxy,
      agent: new HttpsProxyAgent(proxy, { keepAlive: true }),
    };
  return cached.agent;
};
