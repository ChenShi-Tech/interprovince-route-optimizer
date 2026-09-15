# packages/RouteEngine · 端侧算法包

> **当前为空。** 骨架在阶段 1 建立，完整实现在阶段 2 完成。
> Swift Package，**纯逻辑、零依赖**。

---

## 设计目标

把 Web 版 `src/app/algo/` 的算法（`network.js` / `cost.js` / `paths.js` / `solve.js`）移植为 Swift，成为 iOS 端唯一的算法实现。

**这个包存在的全部意义是：能脱离界面单独验证。**

---

## 硬约束

> **不得 import SwiftUI、UIKit，也不得发起网络请求。**

执行方式：在 `Package.swift` 里刻意不声明任何 UI 依赖，让编译器替你守住这条线。

这条纪律一旦破了——哪怕只是"顺手 import 一下 UIKit 好读个颜色"——**算法就再也无法在命令行里跑 1739 条回归了**。与安卓侧 `docs/01-安卓开发框架.md` 是同一条约束。

---

## 对外接口（预期）

```swift
// 枚举全部简单路径
func enumPaths(adj: Adjacency, src: String, dst: String,
               maxHops: Int, cap: Int) -> [[String]]

// 单条路径精确计价（乘性网损）
func evalPath(path: [String], ctx: EvalContext) -> PathResult

// 三口径比选（唯一入口）
func solve(input: SolveInput, data: AppData) -> SolveResult
```

**求解入口应设计为面向协议的**，以便将来并列实现国网与南网两套模型：

```swift
protocol RouteSolver {
    func solve(input: SolveInput, data: AppData) -> SolveResult
}
```

国网省间现货按「交易路径」建模，与本项目图模型一致（规则原文：一对节点间优先选输电价格最低的路径）；**南网区域市场没有交易路径概念**，用断面极限功率 + GSDF 灵敏度约束，是另一套引擎。不要把国网逻辑写死在调用方。

---

## 必须遵守的算法约定

逐条见 [`docs/03-数据接口说明.md`](../../../docs/03-数据接口说明.md) 第四节，iOS 侧摘要见 [`docs/04-数据接入与算法契约.md`](../../docs/04-数据接入与算法契约.md)。关键五条：

1. **网损是乘法项** —— 两步法：线性近似求候选 → 乘性公式精确重算
2. **路径标识用节点序列** `nodes.joined(separator: ">")` —— 不能用边的 from/to
3. **段前系数** `1 / Π_{j≥1}(1 − η_j/100)`
4. **落地价含四项费用 + 网损折价 + 基金附加** —— 送出省输电价格不可漏
5. **容量制工程按等效度电成本参与比选** —— 不可按 0 计

---

## 验收

```bash
swift test
```

必须对 `docs/regression-baseline-v2.json` 的 **503 个省对 / 1739 条路线**全部通过：

| 字段 | 容差 |
|---|---|
| 路径节点序列 | **完全一致** |
| 落地成本 / 过网费 / 送端净收益 / 送达系数 | `1e-4` |

**跑不过就不算完成。**
