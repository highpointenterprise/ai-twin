import { build } from "esbuild";
import { resolve } from "node:path";
let cached: Promise<{ media: string; avatar: string }> | undefined;
// Bundled locally; no CDN or application credentials are injected into Meet.
export function browserAssets(): Promise<{ media: string; avatar: string }> {
  return (cached ??= (async () => {
    const bundle = async (name: string) => {
      const result = await build({
        entryPoints: [resolve("server/meetings/browser", `${name}.ts`)],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "chrome120",
        minify: true,
      });
      return result.outputFiles[0].text;
    };
    const [media, avatar] = await Promise.all([
      bundle("media"),
      bundle("avatar"),
    ]);
    return { media, avatar };
  })());
}
