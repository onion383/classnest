# 相册组件（`components/album/`）

<!-- doc-tree:start -->
## 本篇涉及的文件

只展示本篇会讲到的代码文件；模块内其余文件见同级 README。

```text
classnest/
└── student-frontend/
    └── src/
        └── components/
            └── album/
                └── AlbumYearRuler.vue  # 年份尺
```
<!-- doc-tree:end -->

通用 props / emits（如 `visible`、`editingRecord`、`confirm`、`cancel`）的含义见 [components/README.md](./README.md) 的「通用对外接口标准」；本节只补充组件特有接口。

---

## 详细说明
### [AlbumYearRuler.vue](../../../../student-frontend/src/components/album/AlbumYearRuler.vue) · 年份尺
- **定位**：相册时间轴左侧的年份刻度尺，滚动时高亮当前年份，可点击跳转。
- **对外接口**：`props`（组件属性）：`items`（带日期的数据项）/ `total`（总数）/ `scrollTop`（滚动偏移）/ `clientH`（可视区高度）；`emits`（组件事件）：`seek`（跳到目标滚动位置）。
- **内部实现**：按 `items` 的日期聚合出年份区间，按 `scrollTop` 反算当前年份并高亮；点击刻度触发 `seek(目标 scrollTop)`（跳转）；宽 42px、轴心 x=34，标签相对尺子定位（不塞进 2px 刻度线）。
- **使用方**：`AlbumView`。
- 注意：改尺寸要同步 `AlbumView` 的布局常量，否则年份标签与刻度错位。

---
