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
) & {
  name: string;
  expectText?: string[];
  expectAnyText?: string[];
};

export interface FeishuLiveJourney {
  name: FeishuLiveSurface;
  setupSteps: FeishuLiveJourneyStep[];
  steps: FeishuLiveJourneyStep[];
}

export function buildFeishuLiveJourney(input: {
  surface: FeishuLiveSurface;
  projectKey: string;
}): FeishuLiveJourney {
  if (input.surface === "group") {
    return {
      name: "group",
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
          name: "从入口卡查看群项目列表",
          kind: "click",
          label: "查看项目",
          expectText: ["项目列表", "已绑定当前群"],
        },
        {
          name: "从项目列表回到当前项目",
          kind: "click",
          label: "当前项目",
          expectText: ["当前项目", input.projectKey],
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
    name: "dm",
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
        name: "从当前入口查看线程列表",
        kind: "click",
        label: "切换线程",
        expectText: ["选择线程"],
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
