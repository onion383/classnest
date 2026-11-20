<template>
  <!-- 三个混淆勾选项：一行排布（可换行）。
       纯展示：读写与回滚都在 usePrivacyConfig，气泡文案与「暂不生效」提示在这里。 -->
  <div>
    <h4 class="text-sm font-medium text-text mb-2 flex items-center gap-1.5">
      <span>敏感信息混淆</span>
      <span v-if="masterOff" class="text-[11px] font-normal text-text-muted">总开关未开启，暂不生效</span>
    </h4>
    <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
      <label v-for="it in items" :key="it.key" class="flex items-center gap-1.5 cursor-pointer">
        <input type="checkbox" class="flex-none" :checked="values[it.key]" @change="$emit('change', it.key, $event.target.checked)" />
        <span class="text-sm text-text">{{ it.label }}</span>
        <span class="text-xs text-text-muted">{{ it.hint }}</span>
      </label>
    </div>
  </div>
</template>

<script setup vapor>
// 这两个入口改的是同一份 ai_settings.privacy_json 字段，所以组件只发事件、不自己发请求。
defineProps({
  // 只要含 hide_phone / hide_path / hide_album 三个布尔即可（整份 cfg 传进来也行）
  values: { type: Object, default: () => ({}) },
  // 总开关（或对应的启用开关）关着时，勾选不生效，就地标一句而不是整块隐藏
  masterOff: { type: Boolean, default: false },
})
defineEmits(['change'])

const items = [
  { key: 'hide_phone', label: '电话', hint: '换成令牌' },
  { key: 'hide_path', label: '本地路径', hint: '去掉盘符与用户名' },
  { key: 'hide_album', label: '相册路径', hint: '同样归一化' },
]
</script>
