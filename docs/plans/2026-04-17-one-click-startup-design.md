# 一键启停脚本设计

## 背景

当前项目的本地启动路径依赖人工执行以下步骤：

1. 进入仓库目录
2. 打开 PowerShell
3. 执行 `npm run build`
4. 执行 `npm run start`

这对日常使用成本较高，也容易因为忘记切目录或忘记先 build 而失败。

## 目标

- 提供仓库根目录下可双击的一键启动入口
- 提供仓库根目录下可双击的一键关闭入口
- 复用当前仓库已有的 Windows 启动前清理能力，避免重复维护两套进程清理逻辑
- 保持现有 `npm run start` 前台运行模型不变，让用户仍然可以在启动窗口中直接看到实时日志

## 方案

### 方案 A：根目录 `.cmd` 启动器 + 复用现有 Node 清理逻辑

做法：

- 在仓库根目录新增 `start-coding-anywhere.cmd`
- 在仓库根目录新增 `stop-coding-anywhere.cmd`
- 在 `package.json` 新增 `npm run stop`
- 新增 `scripts/stop.mjs`，内部复用 `scripts/startup-cleanup.mjs`

优点：

- 用户操作最简单，直接双击即可
- 启停行为和当前 npm 脚本一致，不引入新的运行模型
- 复用现有端口/进程清理逻辑，维护成本最低

缺点：

- 启动窗口仍是终端窗口，不是系统托盘应用
- 关闭启动窗口通常会终止服务，不适合做后台常驻守护

### 方案 B：Windows 服务或后台守护模式

做法：

- 改造成服务化启动，或额外引入后台守护器

优点：

- 关闭窗口后仍可继续运行

缺点：

- 超出当前需求
- 增加安装、权限、日志定位和停止方式的复杂度

## 结论

采用方案 A。

这次只补最小闭环：

- `start-coding-anywhere.cmd` 负责切到仓库根目录，先 build，再 start
- `stop-coding-anywhere.cmd` 负责切到仓库根目录，调用统一的 stop 脚本
- `scripts/stop.mjs` 负责复用现有清理逻辑并输出清理结果

## 验证

- 双击 `start-coding-anywhere.cmd` 后应先执行构建，再进入前台服务日志
- 双击 `stop-coding-anywhere.cmd` 后应停止当前项目相关残留进程
- `npm run build` 应继续成功
- 新增自动化测试验证一键脚本存在、工作目录切换逻辑和调用顺序
