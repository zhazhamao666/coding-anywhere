import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

export interface FeishuLiveAuthPaths {
  authDir: string;
  profileDir: string;
  metadataPath: string;
}

export interface FeishuLiveAuthOptions {
  cwd?: string;
  targetUrl?: string;
}

export interface FeishuLiveAuthBootstrapDependencies {
  launchPersistentContext: (
    userDataDir: string,
    options: FeishuLiveBrowserLaunchOptions,
  ) => Promise<{
    pages(): Array<{
      goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
      close(): Promise<void>;
    }>;
    newPage(): Promise<{
      goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
      close(): Promise<void>;
    }>;
    close(): Promise<void>;
  }>;
  mkdirSync?: typeof mkdirSync;
  writeFileSync?: typeof writeFileSync;
  now?: () => Date;
  stdout?: NodeJS.WritableStream;
  stdin?: NodeJS.ReadableStream;
  createInterface?: FeishuLiveReadlineFactory;
}

export interface FeishuLiveBrowserLaunchOptions {
  headless: false;
  viewport: null;
  args: string[];
}

interface FeishuLiveReadline {
  question(query: string, callback: (answer: string) => void): void;
  close(): void;
}

type FeishuLiveReadlineFactory = (options: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}) => FeishuLiveReadline;

const DEFAULT_FEISHU_TARGET_URL = "https://feishu.cn/messages/";
const DEFAULT_CWD = process.cwd();
const FEISHU_LIVE_AUTH_READY_ERROR =
  "[ca] Feishu live auth is not ready. Run `npm run test:feishu:auth` and complete the login flow first.";

export function getFeishuLiveAuthPaths(options?: FeishuLiveAuthOptions): FeishuLiveAuthPaths {
  const cwd = options?.cwd ?? DEFAULT_CWD;
  const authDir = path.join(cwd, ".auth");
  return {
    authDir,
    profileDir: path.join(authDir, "feishu-profile"),
    metadataPath: path.join(authDir, "feishu-live-auth.json"),
  };
}

export function assertFeishuLiveAuthReady(
  options?: FeishuLiveAuthOptions,
  dependencies?: {
    existsSync?: typeof existsSync;
  },
): FeishuLiveAuthPaths {
  const paths = getFeishuLiveAuthPaths(options);
  const hasProfile = (dependencies?.existsSync ?? existsSync)(paths.profileDir);
  if (!hasProfile) {
    throw new Error(FEISHU_LIVE_AUTH_READY_ERROR);
  }
  return paths;
}

export async function bootstrapFeishuLiveAuth(
  options: FeishuLiveAuthOptions | undefined,
  dependencies: FeishuLiveAuthBootstrapDependencies,
): Promise<FeishuLiveAuthPaths> {
  const paths = getFeishuLiveAuthPaths(options);
  const targetUrl = options?.targetUrl ?? DEFAULT_FEISHU_TARGET_URL;
  const writeDir = dependencies.mkdirSync ?? mkdirSync;
  const writeJson = dependencies.writeFileSync ?? writeFileSync;
  const now = dependencies.now ?? (() => new Date());
  const readlineFactory =
    dependencies.createInterface ??
    ((options: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }) =>
      createInterface(options));

  writeDir(paths.authDir, { recursive: true });

  const context = await dependencies.launchPersistentContext(
    paths.profileDir,
    createFeishuLiveBrowserLaunchOptions(),
  );

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
    });

    await waitForOperatorConfirmation({
      createInterface: readlineFactory,
      stdin: dependencies.stdin,
      stdout: dependencies.stdout,
      targetUrl,
    });

    writeJson(
      paths.metadataPath,
      JSON.stringify(
        {
          refreshedAt: now().toISOString(),
          profileDir: paths.profileDir,
          targetUrl,
        },
      ),
      "utf8",
    );
  } finally {
    await context.close();
  }

  return paths;
}

async function waitForOperatorConfirmation(input: {
  createInterface: FeishuLiveReadlineFactory;
  stdin: NodeJS.ReadableStream | undefined;
  stdout: NodeJS.WritableStream | undefined;
  targetUrl: string;
}): Promise<void> {
  input.stdout?.write(
    `[ca] Complete the Feishu login flow in the opened browser, confirm you can reach ${input.targetUrl}, then press Enter here.\n`,
  );

  await new Promise<void>(resolve => {
    const rl = input.createInterface({
      input: input.stdin ?? process.stdin,
      output: input.stdout ?? process.stdout,
    });
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

export function getFeishuLiveAuthReadyErrorMessage(): string {
  return FEISHU_LIVE_AUTH_READY_ERROR;
}

export function createFeishuLiveBrowserLaunchOptions(): FeishuLiveBrowserLaunchOptions {
  return {
    headless: false,
    viewport: null,
    args: ["--start-maximized"],
  };
}
