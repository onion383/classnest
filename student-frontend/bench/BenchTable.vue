<script setup vapor>
/**
 * BenchTable.vue —— 同步循环 bench 的压力组件（**两端共用同一份源码**）
 *
 * 为什么要 `<script setup vapor>`：
 *   Vue 3.5 会逐字忽略 `vapor` 属性 → 本组件按普通 VDOM 组件编译；
 *   Vue 3.6 预览通道会按 Vapor 编译 → 直接生成 DOM 操作。
 *   同一份源码、同一份数据，变量只有编译器与运行时，这是干净 A/B 的前提。
 *
 * 为什么是「200 行 × 8 列」：
 *   · 行数够多 → 单次 mount 进到 1ms 量级，能压过 performance.now 的噪声；
 *   · 每行都有文本插值 / class 绑定 / 条件渲染 / 事件按钮 → 覆盖 Vapor 与 VDOM
 *     差异最大的四类更新（setText / class / 条件分支 / 事件），而不是只测静态节点。
 *
 * 只做展示，不含业务逻辑与数据请求：本文件的唯一职责是「给测量提供负载」。
 */
defineProps({
  data: { type: Object, required: true },
})
</script>

<template>
  <table class="bench-table">
    <thead>
      <tr>
        <th>#</th>
        <th>姓名</th>
        <th>学号</th>
        <th>班级</th>
        <th>分数</th>
        <th>状态</th>
        <th>备注</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in data.list" :key="row.id" :class="row.active ? 'row-on' : 'row-off'">
        <td>{{ row.id }}</td>
        <td>{{ row.name }}</td>
        <td>{{ row.no }}</td>
        <td>{{ row.cls }}</td>
        <td>{{ row.score }}</td>
        <td><span :class="row.score >= 60 ? 'pass' : 'fail'">{{ row.score >= 60 ? '合格' : '不合格' }}</span></td>
        <td>{{ row.note }}</td>
        <td><button type="button" class="row-btn">编辑</button></td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.bench-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12px;
}
.bench-table th,
.bench-table td {
  border: 1px solid #ccc;
  padding: 2px 4px;
  text-align: left;
}
.row-on {
  background: #fff;
}
.row-off {
  background: #f5f5f5;
}
.pass {
  color: #080;
}
.fail {
  color: #b00;
}
.row-btn {
  font-size: 11px;
}
</style>
