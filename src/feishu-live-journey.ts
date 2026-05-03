import type { FeishuLiveSurface } from "./feishu-live-test-settings.js";

export type FeishuLiveJourneyStep = (
  | {
      kind: "command";
      text: string;
    }
  | {
      kind: "upload_file";
      fileName: string;
      content: string;
      mimeType: string;
    }
  | {
      kind: "click";
      label: string;
    }
  | {
      kind: "click_plan_mode_toggle";
      target: "on" | "off";
    }
  | {
      kind: "open_ops_ui";
    }
) & {
  name: string;
  expectText?: string[];
  expectAnyText?: string[];
  expectAbsentText?: string[];
  timeoutMs?: number;
  requireFreshText?: boolean;
};

export interface FeishuLiveJourney {
  name: string;
  surface: FeishuLiveSurface;
  /**
   * Fixture-only preparation. These steps may build or verify the safe autotest
   * context, but they are not counted as the user's primary UI journey.
   */
  setupSteps: FeishuLiveJourneyStep[];
  /**
   * Primary user journey. Keep this close to how a person would operate Feishu:
   * enter from /ca, then follow the returned card buttons and visible UI state.
   */
  steps: FeishuLiveJourneyStep[];
}

export type FeishuLiveScenario =
  | "main"
  | "session"
  | "diagnostics"
  | "plan-toggle"
  | "new-session"
  | "conversation-switch"
  | "run-basic"
  | "bridge-assets"
  | "ops-ui";

export function buildFeishuLiveJourney(input: {
  surface: FeishuLiveSurface;
  projectKey: string;
}): FeishuLiveJourney {
  return buildFeishuLiveJourneys(input)[0] ?? buildMainJourney(input);
}

export function buildFeishuLiveJourneys(input: {
  surface: FeishuLiveSurface;
  projectKey: string;
  scenarios?: string[];
}): FeishuLiveJourney[] {
  const scenarios = normalizeScenarioList(input.surface, input.scenarios);
  return scenarios.map(scenario => buildScenarioJourney(input, scenario));
}

function normalizeScenarioList(
  surface: string,
  scenarios: string[] | undefined,
): FeishuLiveScenario[] {
  const rawScenarios = scenarios && scenarios.length > 0
    ? scenarios
    : ["main"];
  const expanded = rawScenarios.flatMap(scenario =>
    scenario === "all" ? allScenariosForSurface(surface) : [scenario],
  );
  const allowed = new Set(allScenariosForSurface(surface));
  const unique: FeishuLiveScenario[] = [];
  for (const scenario of expanded) {
    if (!allowed.has(scenario as FeishuLiveScenario)) {
      throw new Error(`[ca] Unsupported Feishu live UI scenario for ${surface}: ${scenario}`);
    }
    if (!unique.includes(scenario as FeishuLiveScenario)) {
      unique.push(scenario as FeishuLiveScenario);
    }
  }

  return unique;
}

function allScenariosForSurface(surface: string): FeishuLiveScenario[] {
  if (surface !== "dm" && surface !== "group") {
    throw new Error(`[ca] Unsupported Feishu live UI surface: ${surface}`);
  }

  return [
    "main",
    "session",
    "diagnostics",
    "plan-toggle",
    "new-session",
    "conversation-switch",
    "run-basic",
    "bridge-assets",
    "ops-ui",
  ];
}

function buildScenarioJourney(input: {
  surface: FeishuLiveSurface;
  projectKey: string;
}, scenario: FeishuLiveScenario): FeishuLiveJourney {
  if (scenario === "main") {
    return buildMainJourney(input);
  }

  if (scenario === "ops-ui") {
    return {
      name: `${input.surface}:ops-ui`,
      surface: input.surface,
      setupSteps: [],
      steps: [{
        name: "打开后台观察面",
        kind: "open_ops_ui",
        expectText: ["活跃任务", "排队任务", "取消中", "最近公开进展", "技术元数据"],
        expectAbsentText: ["tool_active", "canceling"],
      }],
    };
  }

  return {
    name: `${input.surface}:${scenario}`,
    surface: input.surface,
    setupSteps: buildThreadReadySetupSteps(input),
    steps: buildThreadReadyScenarioSteps(scenario),
  };
}

function buildMainJourney(input: {
  surface: FeishuLiveSurface;
  projectKey: string;
}): FeishuLiveJourney {
  if (input.surface === "group") {
    return {
      name: "group:main",
      surface: "group",
      setupSteps: [
        {
          name: "确认测试群绑定的是 autotest 项目",
          kind: "command",
          text: "/ca project current",
          expectText: ["当前项目", input.projectKey],
        },
      ],
      steps: [
        {
          name: "打开群入口卡",
          kind: "command",
          text: "/ca",
          expectAnyText: ["当前群已绑定项目", "当前会话已就绪"],
        },
        {
          name: "查看群项目列表",
          kind: "command",
          text: "/ca project list",
          expectText: ["项目列表", "已绑定当前群"],
        },
        {
          name: "从项目列表回到当前项目",
          kind: "click",
          label: "当前项目",
          expectText: ["当前项目", input.projectKey],
        },
        {
          name: "从当前项目查看会话列表",
          kind: "click",
          label: "会话列表",
          expectText: ["选择会话"],
        },
        {
          name: "查看运行状态",
          kind: "command",
          text: "/ca status",
          expectText: ["运行状态"],
        },
      ],
    };
  }

  return {
    name: "dm:main",
    surface: "dm",
    setupSteps: [
      {
        name: "确认测试 DM 已切到 autotest 项目",
        kind: "command",
        text: `/ca project switch ${input.projectKey}`,
        expectText: ["当前项目已切换"],
      },
    ],
    steps: [
      {
        name: "打开 DM 入口卡",
        kind: "command",
        text: "/ca",
        expectAnyText: ["当前项目已选择", "当前会话已就绪"],
      },
      {
        name: "点击入口卡查看项目列表",
        kind: "click",
        label: "查看项目",
        expectText: ["选择项目", input.projectKey, "进入项目"],
      },
      {
        name: "从项目列表回到当前会话入口",
        kind: "click",
        label: "返回当前会话",
        expectAnyText: ["当前项目已选择", "当前会话已就绪"],
      },
        {
          name: "从当前入口查看会话列表",
          kind: "click",
          label: "选择会话",
          expectText: ["切换到此会话"],
        },
      {
        name: "查看运行状态",
        kind: "command",
        text: "/ca status",
        expectText: ["运行状态"],
      },
      {
        name: "查看当前会话入口",
        kind: "command",
        text: "/ca session",
        expectAnyText: ["当前项目已选择", "当前会话已就绪"],
      },
    ],
  };
}

function buildThreadReadySetupSteps(input: {
  surface: FeishuLiveSurface;
  projectKey: string;
}): FeishuLiveJourneyStep[] {
  if (input.surface === "group") {
    return [
      {
        name: "确认测试群绑定的是 autotest 项目",
        kind: "command",
        text: "/ca project current",
        expectText: ["当前项目", input.projectKey],
      },
      {
        name: "打开测试群会话列表",
        kind: "command",
        text: "/ca thread list-current",
        expectText: ["切换到此会话"],
        requireFreshText: false,
      },
      {
        name: "切到一个已有会话",
        kind: "click",
        label: "切换到此会话",
        expectText: ["当前会话已就绪"],
        timeoutMs: 90_000,
        requireFreshText: false,
      },
    ];
  }

  return [
    {
      name: "确认测试 DM 已切到 autotest 项目",
      kind: "command",
      text: `/ca project switch ${input.projectKey}`,
      expectText: ["当前项目已切换"],
    },
    {
      name: "打开测试 DM 会话列表",
      kind: "command",
      text: "/ca thread list-current",
      expectText: ["切换到此会话"],
      requireFreshText: false,
    },
    {
      name: "切到一个已有会话",
      kind: "click",
      label: "切换到此会话",
      expectText: ["当前会话已就绪"],
      timeoutMs: 90_000,
      requireFreshText: false,
    },
  ];
}

function buildThreadReadyScenarioSteps(scenario: FeishuLiveScenario): FeishuLiveJourneyStep[] {
  switch (scenario) {
    case "session":
      return [
        {
          name: "查看标准会话卡",
          kind: "command",
          text: "/ca session",
          expectText: ["当前会话已就绪", "下次任务设置", "模型", "推理", "速度", "计划模式", "作用范围"],
          requireFreshText: false,
        },
      ];
    case "diagnostics":
      return [
        {
          name: "打开标准会话卡",
          kind: "command",
          text: "/ca session",
          expectText: ["当前会话已就绪", "更多信息"],
          requireFreshText: false,
        },
        {
          name: "打开更多信息诊断卡",
          kind: "click",
          label: "更多信息",
          expectText: ["上下文", "最近运行", "返回当前会话"],
        },
        {
          name: "返回标准会话卡",
          kind: "click",
          label: "返回当前会话",
          expectText: ["当前会话已就绪", "下次任务设置", "计划模式"],
        },
      ];
    case "plan-toggle":
      return [
        {
          name: "打开标准会话卡",
          kind: "command",
          text: "/ca session",
          expectText: ["当前会话已就绪", "计划模式"],
          requireFreshText: false,
        },
        {
          name: "打开计划模式单次开关",
          kind: "click_plan_mode_toggle",
          target: "on",
          expectText: ["计划模式 [开]", "直接发送你的需求，我会按计划模式处理"],
        },
        {
          name: "关闭计划模式单次开关",
          kind: "click_plan_mode_toggle",
          target: "off",
          expectText: ["计划模式 [关]"],
        },
      ];
    case "new-session":
      return [
        {
          name: "打开会话选择卡",
          kind: "command",
          text: "/ca thread list-current",
          expectText: ["切换到此会话", "新会话"],
          requireFreshText: false,
        },
        {
          name: "从选择卡准备新会话",
          kind: "click",
          label: "新会话",
          expectText: ["选择会话"],
          expectAnyText: ["当前项目已选择", "当前群已绑定项目"],
          requireFreshText: false,
        },
      ];
    case "conversation-switch":
      return [
        {
          name: "打开会话选择卡",
          kind: "command",
          text: "/ca thread list-current",
          expectText: ["选择会话", "切换到此会话"],
          requireFreshText: false,
        },
        {
          name: "切换到一个已有会话",
          kind: "click",
          label: "切换到此会话",
          expectText: ["当前会话已就绪", "下次任务设置"],
          timeoutMs: 90_000,
          requireFreshText: false,
        },
      ];
    case "run-basic":
      return [
        {
          name: "发送一条短任务并等待终态卡",
          kind: "command",
          text: "请只回复：autotest-ui-ok",
          expectAnyText: ["Codex 最终返回了什么", "任务出错", "已停止"],
          timeoutMs: 180_000,
        },
        {
          name: "确认终态后续动作存在",
          kind: "command",
          text: "/ca session",
          expectText: ["当前会话已就绪", "下次任务设置", "计划模式"],
          requireFreshText: false,
        },
      ];
    case "bridge-assets":
      return buildBridgeAssetsScenarioSteps();
    case "main":
    case "ops-ui":
      return [];
  }
}

function buildBridgeAssetsScenarioSteps(): FeishuLiveJourneyStep[] {
  const runSuffix = buildLiveBridgeAssetRunSuffix();
  const inboundFileName = `live-inbound-file-${runSuffix}.md`;
  const inboundFileToken = `live-inbound-file-ok-${runSuffix}`;
  const assetBaseName = `live-outbound-assets-${runSuffix}`;
  const outboundToken = `live-outbound-assets-ok-${runSuffix}`;
  const assetDir = `feishu-live-bridge-assets/${runSuffix}`;

  return [
    {
      name: "准备干净新会话",
      kind: "command",
      text: "/ca new",
      expectAnyText: ["当前项目已选择", "当前群已绑定项目"],
    },
    {
      name: "上传 Markdown 附件",
      kind: "upload_file",
      fileName: inboundFileName,
      mimeType: "text/markdown",
      content: [
        "# Feishu live inbound file smoke",
        "",
        `stable_token: ${inboundFileToken}`,
        "",
      ].join("\n"),
      expectText: ["已收到文件", inboundFileName],
      timeoutMs: 90_000,
    },
    {
      name: "要求 Codex 读取刚才附件",
      kind: "command",
      text: `请只处理本轮 [bridge-attachments] 中 file_name 等于 ${inboundFileName} 的 Markdown 附件。不要扫描仓库，不要读取历史消息。用 local_path 读取该文件，找到 stable_token 字段，并且只回复该字段值。不要解释。`,
      expectText: [inboundFileToken],
      timeoutMs: 360_000,
    },
    {
      name: "要求 Codex 返回桥接资源",
      kind: "command",
      text: [
        "请执行真实飞书资源桥 smoke。不要扫描仓库，不要运行测试，不要解释；只创建 3 个文件并最终回复桥接块。",
        `dir = [bridge-output-assets] root_path + '/${assetDir}'`,
        `base = ${assetBaseName}`,
        `suffix = ${runSuffix}`,
        "PNG Base64 = iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "要求：",
        "1. 在当前工作目录创建 dir。",
        "2. 把 PNG Base64 解码写入 dir + '/' + base + '.png'。",
        "3. 写入 dir + '/' + base + '.md'，内容包含 token: live-outbound-assets-md-token。",
        "4. 写入 dir + '/' + base + '.drawio'，内容是合法 draw.io XML，且包含 token: live-outbound-assets-drawio-token。",
        "5. 最终回复第一行用 live、outbound、assets、ok、suffix 这 5 段按顺序用短横线拼接。",
        "6. 第一行后紧跟 [bridge-assets] JSON 块和 [/bridge-assets] 结束标签；JSON 里 assets 包含 image、Markdown file、drawio file。path 分别用 dir + '/' + base + '.png'、dir + '/' + base + '.md'、dir + '/' + base + '.drawio'；Markdown 使用 presentation=markdown_preview；drawio 使用 presentation=drawio_with_preview 且 preview format 为 png。",
      ].join(" "),
      expectText: [
        outboundToken,
        `${assetBaseName}.md`,
        `${assetBaseName}.drawio`,
      ],
      timeoutMs: 360_000,
    },
  ];
}

function buildLiveBridgeAssetRunSuffix(): string {
  const explicitSuffix = process.env.FEISHU_LIVE_RUN_SUFFIX?.trim();
  const rawSuffix = explicitSuffix || `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const suffix = rawSuffix.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return suffix || `${Date.now().toString(36)}-${process.pid.toString(36)}`;
}
