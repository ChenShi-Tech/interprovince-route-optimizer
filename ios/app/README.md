# app/ · Xcode 工程本体

> **当前为空。** 工程在阶段 0 创建。

---

## 创建规范

| 项 | 取值 |
|---|---|
| 工程名 | `InterprovinceRoute` |
| 产品名（显示名） | 省间路径优选 |
| Bundle ID | `com.chenshi.iproute`（走组织账号时须体现组织域名） |
| 最低系统版本 | **iOS 17**（SwiftData 与 `@Observable` 的下限；与本项目的工具链能力匹配） |
| 语言 | Swift（Swift 6 language mode） |
| 界面 | SwiftUI |
| 测试框架 | **Swift Testing**（不是 XCTest） |
| 依赖管理 | Swift Package Manager |

最低系统版本定 **iOS 17** 的前提是能覆盖交易员手上的设备。若实际设备分布更旧，需要复核——`@Observable` 与 SwiftData 都要求 iOS 17+。

---

## 目录约定

```
InterprovinceRoute/
├── App/                  入口、导航装配、依赖注入
├── Features/             按功能分模块
│   ├── Calc/             测算：参数、方案列表、方案详情
│   ├── TariffLibrary/    费率库：浏览、编辑、版本对比
│   ├── Map/              网架图：拓扑图 / 天地图
│   └── DataAdmin/        数据管理：导入导出、版本信息
├── Models/               Codable 模型，与 app-data.json 对齐
├── Storage/              SwiftData 模型、迁移、留痕
└── Resources/            app-data.min.json、AppIcon、LaunchScreen
```

模块名与 `android/`、Web 版保持一致，便于三端讨论同一个功能时对齐口径。

---

## 硬约束

1. **不得直接改 `Resources/app-data.min.json`。** 它是构建产物，源头是 `data/fixed-prices.json`。改价格只改源头，然后重新构建。
2. **不得在此目录实现路径枚举与计价逻辑。** 那属于 `../packages/RouteEngine/`。
3. **不得内嵌任何有效地图密钥。**
4. 新增模块前先读 [`../docs/03-工程结构与模块划分.md`](../docs/03-工程结构与模块划分.md) 的依赖方向图。
