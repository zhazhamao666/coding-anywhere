import type { FeishuLiveSurface } from "./feishu-live-test-settings.js";

export type FeishuLiveJourneyStep = (
  | {
      kind: "command";
      text: string;
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
          requireFreshText: false,
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
        requireFreshText: false,
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
        requireFreshText: false,
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
      requireFreshText: false,
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
    case "main":
    case "ops-ui":
      return [];
  }
}
