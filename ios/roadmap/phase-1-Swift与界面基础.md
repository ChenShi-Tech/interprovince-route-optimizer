# 阶段 1 · Swift 与界面基础

> 周期：1–2 周 ｜ 里程碑：**M1 · 可看** ｜ 前置：阶段 0 完成

---

## 一、核心目标

两条线同时推进，一条收敛人，一条收敛工程：

1. **人**：把团队的前端心智（TypeScript / React）映射到 SwiftUI，能独立写出「参数输入 → 计算 → 列表 → 详情」这条主链。
2. **工程**：把算法包的地基和纪律立起来——`packages/RouteEngine` 骨架 + 第一批单元测试。

这一阶段允许粗糙，但**不允许破坏依赖方向**。地基歪了，阶段 2 的回归就无从谈起。

---

## 二、关键技术点与所需技能

### 2.1 Swift 语言（对着 TypeScript 学，不从头学）

| 概念 | 与前端心智的映射 |
|---|---|
| `struct` / `enum` 值语义 | 类似 TS 的对象字面量与联合类型，但默认拷贝、不可变优先 |
| 可选类型 `Optional` | 类似 `T \| undefined`，但编译器强制解包处理 |
| `Codable` | 类似 JSON.parse + 类型校验，但**是编译期生成的** |
| `throws` / `Result` | 类似 Promise reject，但同步轴上的显式错误传播 |
| `async` / `await` | 与 JS 高度一致，学习成本最低的一块 |
| `protocol` / 扩展 | 类似 TS interface + mixin |
| **Swift 6 严格并发** | `actor`、`Sendable`。**这一块是新增成本**——编译器会强制你标注跨线程传递的数据是否安全 |

### 2.2 数据建模纪律（本项目特有）

用 Swift `Decodable` 严格对齐 `shared/app-data.json` 时：

- **字段名不一致处显式写 `CodingKeys`，不要开 `convertFromSnakeCase`。** 自动转换会让漏字段静默变成 `nil`，而"某条通道的费率悄悄消失了"这种 bug 在数值结果上表现为"算得偏小"，极难定位。
- **关键字段用非可选类型 + 自定义 `init(from:)`**，缺字段时直接抛错。**宁可启动失败，也不要算出一个看起来正常的错值。**
- 解码后立即校验 `priceVersion` 与 `dataHash`。

### 2.3 SwiftUI 基础

| 能力 | 要素 |
|---|---|
| 状态 | `@State` / `@Binding` / `@Observable`（Observation 框架），理解"单一数据源 + 派生视图" |
| 导航 | `NavigationStack` + `navigationDestination` |
| 列表 | `List` / `LazyVStack`；30 节点 / 70 通道不需要分页 |
| 表单 | `Form` + `Picker` / `TextField`，用于送端省 / 受端省 / 电量输入 |
| 绘图 | `Canvas`（画拓扑图）、`Shape`、`Path` |
| 图表 | Swift Charts，用于成本拆解堆叠条 |

### 2.4 测试

**Swift Testing**（`@Test` / `#expect` / `@Suite`），不是 XCTest。目标是让阶段 2 的 1739 条回归能自动跑。

### 2.5 工程纪律（硬约束）

> **`packages/RouteEngine` 不得 import 任何 SwiftUI / UIKit / Foundation 网络相关模块。**

理由与安卓侧完全一致：它是唯一能脱离界面单独验证的部分。这条一旦破了，算法就再也没法在命令行里快速回归。

---

## 三、交付物

三个小程序，建议按顺序做（可叠加，但前两个各自独立成立）：

| # | 交付物 | 内容 | 训练到的东西 |
|---|---|---|---|
| 1 | **费率库浏览器** | 读 `shared/app-data.json`，展示通道列表 + 省级参数 + 断面，支持搜索与详情 | `Codable`、列表与导航、字符串格式化 |
| 2 | **网架图小程序** | 用 `Canvas` 画出 30 个省级节点与 70 条通道，支持高亮指定路径 | 绘图、坐标变换、几何计算 |
| 3 | **`RouteEngine` 骨架** | 图与邻接表、几何与绕行度、路径标识（节点序列），配套 **10 个单元测试** | 纯逻辑包、测试驱动 |

---

## 四、验收标准

| 项 | 判定 |
|---|---|
| 测试 | `swift test` 全绿 |
| 数据 | App 启动时校验 `priceVersion` 与 `dataHash`，不匹配时明确提示 |
| 性能 | 模拟器里翻完 30 个省级节点与 70 条通道无卡顿 |
| 纪律 | `packages/RouteEngine` 的依赖清单里没有 UI / 网络库——可人工审查 `Package.swift` |
| 健壮性 | 人为删掉 `app-data.json` 里一个必填字段，App 应报错而非静默算出结果 |

---

## 五、风险

| 风险 | 应对 |
|---|---|
| 用 React 心智写 SwiftUI，状态管理乱套 | 先只用一个 `@Observable` 模型类承载全局状态，不要过早拆分 |
| `convertFromSnakeCase` 掩盖字段缺失 | 明确禁止；用显式 `CodingKeys` + 非可选类型 |
| Swift 6 严格并发报错刷屏 | 阶段 1 可暂用 `@MainActor` 标注整个视图层规避；阶段 2 再把计算移出主线程，并正确处理 `Sendable` |
| 算法包被 UI 依赖污染 | 在 `Package.swift` 中刻意不声明 UI 依赖，让编译器替你守住这条线 |

---

## 六、下一步

进入 [阶段 2 · 最小可用测算](./phase-2-最小可用测算.md)——**这是整条路线唯一不可让步的阶段**。
