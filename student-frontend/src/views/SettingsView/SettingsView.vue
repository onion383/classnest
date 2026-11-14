<template>
  <div class="settings-view h-full">
    <!-- 顶部标题栏 -->
    <div class="w-full bg-surface shadow-md rounded-xl mb-6 px-5 py-3 border border-border min-h-[4.5rem] flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold text-text flex items-center gap-2"><IconGlyph name="settings" /> 系统设置</h1>

      <!-- 设置项搜索：输入即匹配，结果以悬浮弹窗形式出现在搜索框下方 -->
      <div class="relative flex-shrink-0">
        <input
          ref="settingsSearchInput"
          v-model="settingsSearch"
          type="text"
          @focus="onSettingsSearchFocus"
          @blur="onSettingsSearchBlur"
          @keydown.down.prevent="moveSearchActive(1)"
          @keydown.up.prevent="moveSearchActive(-1)"
          @keydown.enter.prevent="confirmSearchActive"
          class="block h-9 w-64 pl-[60px] pr-9 border border-border rounded-lg bg-bg text-sm text-text focus:outline-none focus:border-primary"
        />
        <span class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-muted pointer-events-none">搜索</span>
        <span class="absolute left-12 top-1/2 -translate-y-1/2 w-px h-4 bg-border pointer-events-none"></span>
        <span class="absolute right-3 top-1/2 -translate-y-1/2 flex items-center text-text-muted pointer-events-none"><IconGlyph name="search" :size="16" tint="current" /></span>
      </div>

      <!-- 结果悬浮弹窗：与对话框窗口（删除确认 / 数据迁移等）同一套毛玻璃材质，即 .bg-surface 玻璃卡片。
           Teleport 到 body 且行内强制 position: fixed：毛玻璃主题下 .bg-surface 会把 position 设为
           relative 并附加 contain: paint，留在原位置会被裁切、退化为普通流内元素，无法悬浮。 -->
      <Teleport to="body">
        <div
          v-if="settingsSearchOpen"
          ref="settingsSearchPopup"
          class="settings-search-popup fixed z-[10002] bg-surface rounded-lg shadow-card"
          :style="{ position: 'fixed', left: searchPopup.left + 'px', top: searchPopup.top + 'px', width: searchPopup.width + 'px', height: '320px', overflow: 'auto' }"
        >
          <template v-if="settingsSearchResults.length">
            <div
              v-for="(item, idx) in settingsSearchResults"
              :key="item.id"
              @mousedown.prevent="goToSettingsSection(item)"
              @mouseenter="searchActiveIndex = idx"
              class="settings-search-row px-3 py-2 text-sm text-text cursor-pointer truncate"
              :class="idx === searchActiveIndex ? 'bg-info/20' : 'hover:bg-info/10'"
              :style="{ animationDelay: Math.min(idx, 10) * 30 + 'ms' }"
            >{{ item.label }}</div>
          </template>
          <!-- 无匹配时同样保留弹窗（只是内容为空提示），沿用同一套浮入动画 -->
          <div v-else class="settings-search-row px-3 py-2 text-sm text-text-muted">无匹配的设置项</div>
        </div>
      </Teleport>
    </div>

    <!-- ========== 账号管理 ========== -->
    <div class="mb-6">
      <h2 id="settings-section-account" class="text-xl font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="user" :size="20" /> 账号管理</h2>

      <div class="bg-surface rounded-lg border border-border p-6">
        <h3 class="text-lg font-semibold text-text mb-4">账号信息</h3>
        <div class="flex items-center justify-between flex-wrap gap-4">
          <div class="space-y-2 text-text-secondary">
            <p><span class="text-text-muted">当前用户：</span>{{ user.username }}</p>
            <p><span class="text-text-muted">权限：</span>{{ user.role === 'teacher' ? '班主任' : '科任老师' }}</p>
            <!-- 当前班级：多班级才给「切换」。点开的和首页齿轮是同一个班级弹窗
                 （下拉切班 + 铅笔改名 + 新建班级），两处不再各做一套。
                 单班账号只显示班名，没有可切的东西。 -->
            <div class="flex items-center gap-2 flex-wrap">
              <span><span class="text-text-muted">当前班级：</span>{{ currentClassName || '—' }}</span>
              <button v-if="classList.length > 1" type="button" @click="openClassDialog"
                class="glass-switch">切换</button>
            </div>
          </div>
          <div class="flex gap-3">
            <button @click="openModal('username')" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme">修改用户名</button>
            <!-- 明文 / 无密码两档没有登录密码，也就没有「修改密码」可改：设密码请走「安全等级」 -->
            <button v-if="hasLoginPassword" @click="openModal('password')" class="bg-info hover:bg-info-hover text-text-inverse px-4 py-2 rounded transition-theme">修改密码</button>
            <button @click="openModal('export')" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded transition-theme" :disabled="busyExport">导出数据库</button>
            <button @click="confirmLogout" class="bg-danger hover:bg-danger-hover text-text-inverse px-4 py-2 rounded transition-theme">退出登录</button>
          </div>
        </div>

        <!-- 安全等级：明文 / 免密 / 普通密码 / 超级隐私（明文可升级为加密） -->
        <div class="mt-6 pt-5 border-t border-border">
          <div class="flex items-center gap-4">
            <label class="text-sm font-medium text-text w-40 flex-shrink-0">安全等级</label>
            <div class="w-80">
              <AppSelect
                :model-value="securityLevel"
                :options="securityLevelOptions"
                :disabled="securityLevelLoading || busySecurityLevel"
                @change="onSecurityLevelChange"
              />
            </div>
            <span class="text-xs text-text-muted">{{ securityLevelHint }}</span>
          </div>
          <p class="text-xs text-text-muted mt-2 ml-44">明文不加密；无密码仅免登录但仍加密；普通密码用密码登录；超级隐私模式需密码或恢复词才能解锁库密钥。</p>
        </div>
      </div>
    </div>

    <!-- 切换为超级隐私后的恢复词：与注册共用同一个弹窗，同样强制下载 + 抄写前 3 词 -->
    <RecoveryKeyDialog
      v-if="recoveryMounted"
      :visible="!!privacyPhrase"
      :phrase="privacyPhrase"
      :username="user.username"
      title="保存恢复词"
      description="已切换为超级隐私模式。恢复词是忘记密码时的唯一凭证，只显示这一次；请先下载到本地，再抄写前 3 个词完成确认。"
      confirm-text="我已抄写并保存"
      @confirm="onPrivacyPhraseSaved"
    />

    <!-- 修改密码 → 忘记密码：已登录，账号已知 —— 不列账号，直接用本机库验证当前账号 -->
    <LocalRecoverDialog
      :visible="localRecoverVisible"
      :slug="(user && user.dbSlug) || ''"
      :username="(user && user.username) || ''"
      @done="onLocalRecoverDone"
      @close="localRecoverVisible = false"
    />

    <!-- 内嵌弹窗：切换安全等级 -->
    <Teleport to="body">
    <Transition name="dialog">
      <div v-if="securityDialog.open" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001]" @click.self="closeSecurityDialog">
        <div class="dialog-card bg-surface rounded-lg p-6 w-[26rem] border border-border shadow-lg">
          <h3 class="text-lg font-bold text-text mb-3">切换安全等级</h3>
          <p class="text-sm text-text-secondary mb-4">{{ securityDialogMessage }}</p>
          <input v-if="securityNeedsCurrent" v-model="securityDialog.password" type="password" placeholder="当前登录密码" autocomplete="current-password" class="border border-border bg-surface text-text p-2 w-full mb-3 rounded" />
          <input v-if="securityNeedsNew" v-model="securityDialog.newPassword" type="password" placeholder="新登录密码（至少 6 位）" autocomplete="new-password" class="border border-border bg-surface text-text p-2 w-full mb-3 rounded" />
          <!-- 二次确认：首次设密码打错一个字就进不去自己刚设的墙。普通密码还能在原机走本机信息恢复，
               超级隐私只有恢复词，所以提示语按目标等级分开（见 securityNewPwdHint） -->
          <input v-if="securityNeedsNew" v-model="securityDialog.confirmPassword" type="password" placeholder="再次输入新登录密码" autocomplete="new-password" class="border border-border bg-surface text-text p-2 w-full mb-1 rounded" />
          <!-- 同样不在输入过程提示「一致 / 不一致」，只保留按目标等级区分的说明 -->
          <p v-if="securityNeedsNew" class="text-xs text-text-muted mb-3">{{ securityNewPwdHint }}</p>
          <p v-if="securityDialog.error" class="text-sm text-danger mb-3">{{ securityDialog.error }}</p>
          <div class="flex justify-end gap-2">
            <button @click="closeSecurityDialog" class="bg-surface-hover text-text px-4 py-2 rounded border border-border transition-theme">取消</button>
            <button @click="confirmSecurityLevel" :disabled="busySecurityLevel" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-50">{{ busySecurityLevel ? '切换中…' : '确认切换' }}</button>
          </div>
        </div>
      </div>
    </Transition>
    </Teleport>

    <!-- ========== 学期设置 ========== -->
    <div class="mb-6">
      <div class="flex items-center justify-between mb-4">
        <h2 id="settings-section-semester" class="text-xl font-semibold text-text flex items-center gap-2"><IconGlyph name="calendar" :size="20" /> 学期设置</h2>
        <button
          @click="openAddSemester"
          :disabled="busySemester"
          class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-40 disabled:cursor-not-allowed"
        >增加学期</button>
      </div>

      <div class="bg-surface rounded-lg border border-border p-6">
        <div class="flex items-center gap-4 mb-6">
          <label class="text-sm font-medium text-text w-40 flex-shrink-0">选择学期</label>
          <div class="w-64">
            <AppSelect :model-value="semesterId" :options="semesterOptions" placeholder="选择学期" @change="onSelectSemester" />
          </div>
          <button
            @click="openRenameSemester"
            :disabled="!semesterId"
            class="bg-surface-hover text-text border border-border px-4 py-2 rounded transition-theme disabled:opacity-40 disabled:cursor-not-allowed"
          >修改学期名</button>
          <button
            @click="requestDeleteSemester"
            :disabled="!semesterId || busySemester"
            class="bg-danger text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-40 disabled:cursor-not-allowed"
          >删除学期</button>
        </div>
        <div class="flex items-center gap-4 mb-2">
          <label class="text-sm font-medium text-text w-40 flex-shrink-0">学期开始时间</label>
          <input
            type="date"
            v-model="semesterStart"
            @input="semesterDateErrorText = ''"
            :class="{ 'border-danger': semesterDateError || semesterDateErrorText }"
            class="border border-border bg-bg text-text px-3 py-2 rounded-lg"
          />
        </div>
        <div class="flex items-center gap-4 mb-2">
          <label class="text-sm font-medium text-text w-40 flex-shrink-0">学期结束时间</label>
          <input
            type="date"
            v-model="semesterEnd"
            @input="semesterDateErrorText = ''"
            :class="{ 'border-danger': semesterDateError || semesterDateErrorText }"
            class="border border-border bg-bg text-text px-3 py-2 rounded-lg"
          />
        </div>
        <!-- 校验错误：结束早于开始。存反了会让值日/座位的快照补存整段跳过（范围上界 < 下界），
             而结束日期正是那两处的补存范围上界 —— 必须在写库前拦住。 -->
        <p v-if="semesterDateError || semesterDateErrorText" class="text-sm text-danger mb-2 ml-44">
          {{ semesterDateErrorText || semesterDateError }}
        </p>
        <div class="flex items-center gap-4 mb-2">
          <label class="text-sm font-medium text-text w-40 flex-shrink-0">本学期时长</label>
          <span class="text-sm text-text-secondary">{{ semesterWeeks ? `共 ${semesterWeeks} 周` : '—' }}</span>
        </div>
        <div class="flex items-center gap-4 mb-4">
          <div class="w-40 flex-shrink-0"></div>
          <button
            @click="saveSemesterSettings"
            :disabled="!semesterId || !semesterDatesDirty || busySemesterDate || !!semesterDateError"
            class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-40 disabled:cursor-not-allowed"
          >{{ busySemesterDate ? '保存中…' : '保存日期' }}</button>
          <span v-if="!semesterDatesDirty && !busySemesterDate" class="text-xs text-text-muted">日期未改动</span>
        </div>
        <p class="text-xs text-text-muted mt-4">座位快照按天补存与座位指数结算均以当前学期范围为准</p>
      </div>
    </div>

    <!-- 增加学期（小弹窗：输入学期名；起止日期由后端按当前月份推算，之后可在上面调整） -->
    <Teleport to="body">
      <Transition name="dialog">
        <div v-if="showAddSemester" class="fixed inset-0 bg-black/40 flex items-center justify-center z-[10003]" @click.self="showAddSemester = false">
          <div class="bg-surface p-6 rounded-xl w-[26rem] shadow-card dialog-card border border-border">
            <h3 class="text-lg font-bold text-text mb-4">增加学期</h3>
            <input
              v-model="newSemesterName"
              placeholder="请输入学期名，如：2026秋季学期"
              class="border border-border bg-surface text-text px-3 py-2 rounded w-full mb-4"
              @keydown.enter="confirmAddSemester"
            />
            <div class="flex justify-end gap-2">
              <button @click="showAddSemester = false" class="bg-surface-hover text-text border border-border px-4 py-2 rounded transition-theme cursor-pointer">取消</button>
              <button @click="confirmAddSemester" class="bg-primary text-text-inverse px-4 py-2 rounded transition-theme cursor-pointer">确定</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 修改学期名（小弹窗：输入新名字，确定后即时保存） -->
    <Teleport to="body">
      <Transition name="dialog">
        <div v-if="showRenameSemester" class="fixed inset-0 bg-black/40 flex items-center justify-center z-[10003]" @click.self="showRenameSemester = false">
          <div class="bg-surface p-6 rounded-xl w-[26rem] shadow-card dialog-card border border-border">
            <h3 class="text-lg font-bold text-text mb-4">修改学期名</h3>
            <input
              v-model="semesterNameDraft"
              placeholder="如：2026秋季学期"
              class="border border-border bg-surface text-text px-3 py-2 rounded w-full mb-4"
              @keydown.enter="saveSemesterName"
            />
            <div class="flex justify-end gap-2">
              <button @click="showRenameSemester = false" class="bg-surface-hover text-text border border-border px-4 py-2 rounded transition-theme cursor-pointer">取消</button>
              <button @click="saveSemesterName" class="bg-primary text-text-inverse px-4 py-2 rounded transition-theme cursor-pointer">确定</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 删除学期确认 -->
    <ConfirmDialog
      :visible="showDeleteSemester"
      title="删除学期"
      :message="deleteSemesterMessage"
      confirm-text="删除"
      cancel-text="取消"
      :show-cancel="true"
      @confirm="confirmDeleteSemester"
      @cancel="showDeleteSemester = false"
    />

    <!-- ========== 撤销记录 ========== -->
    <div class="mb-6">
      <div class="flex items-center justify-between mb-4">
        <h2 id="settings-section-undo" class="text-xl font-semibold text-text flex items-center gap-2"><IconGlyph name="undo" :size="20" /> 撤销记录</h2>
        <button
          v-if="hasUndoRecords"
          @click="clearUndo"
          class="text-sm text-danger hover:underline disabled:opacity-40"
          :disabled="busyUndo"
        >清空所有撤销记录</button>
      </div>

      <div class="bg-surface rounded-lg border border-border p-6 relative">

        <div v-if="!hasUndoRecords" class="text-sm text-text-muted text-center py-8">
          暂无编辑记录。在表格中修改数据后，这里会记录该次操作，之后可一键撤销、跨重启保留。
        </div>

        <div v-else ref="undoListRef" class="space-y-6 max-h-[22rem] overflow-y-auto pr-1 app-custom-scroll">
          <div v-for="group in undoGroups" :key="group.key" class="border border-border rounded-lg overflow-hidden">
            <div class="flex items-center justify-between px-4 py-2.5 bg-surface-hover border-b border-border">
              <span class="font-medium text-text">{{ groupLabel(group.key) }}</span>
              <span class="text-xs text-text-muted">{{ undoableCount(group) }} 步可撤销</span>
            </div>
            <ul class="divide-y divide-border max-h-72 overflow-auto">
              <!-- 一「行」= 一步动作：同一次改动登记的多条在这里折成一行，与 Ctrl+Z 口径一致 -->
              <li v-for="ent in group.entries" :key="ent.key"
                  class="flex items-center justify-between gap-3 px-4 py-2 hover:bg-surface-hover transition-theme">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-xs text-text-muted flex-shrink-0">{{ fmtTs(ent.ts) }}</span>
                  <span class="text-sm text-text truncate">{{ ent.label }}</span>
                  <span v-if="ent.dir === 0" class="text-[11px] text-info flex-shrink-0">已撤销</span>
                </div>
                <div class="flex-shrink-0">
                  <button
                    v-if="ent.dir === 1"
                    @click="undoEntry(ent)"
                    class="bg-warning hover:bg-warning-hover text-text-inverse text-xs px-3 py-1 rounded transition-theme disabled:opacity-40"
                    :disabled="busyUndo"
                  >撤销</button>
                  <button
                    v-else
                    @click="redoEntry(ent)"
                    class="bg-info hover:bg-info-hover text-text-inverse text-xs px-3 py-1 rounded transition-theme disabled:opacity-40"
                    :disabled="busyUndo"
                  >重做</button>
                </div>
              </li>
            </ul>
          </div>
        </div>
        <!-- 撤销记录：细滑块 + 淡入；卡片 relative，覆盖层落在右侧内边距里 -->
        <CustomScrollbar :target="undoListRef" compact :arrows="false" auto-hide :min-thumb="22" />

      </div>
    </div>

    <!-- ========== 主题设置 ========== -->
    <div class="mb-6">
      <h2 id="settings-section-theme" class="text-xl font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="palette" :size="20" /> 主题设置</h2>

      <div class="bg-surface rounded-lg border border-border p-6">
          <!-- 主题设置区：主题选择 + 图标样式 -->
          <div class="flex items-center gap-4 mb-6">
            <label class="text-sm font-medium text-text w-16 flex-shrink-0">主题</label>
            <AppSelect
              v-model="selectedThemeId"
              @change="onThemeSelect"
              :options="themeOptions"
              class="w-56"
            />
          </div>

          <!-- 图标样式切换 -->
          <div class="flex items-center gap-4 mb-6">
            <label class="text-sm font-medium text-text w-16 flex-shrink-0">图标样式</label>
            <AppSelect
              v-model="iconStyle"
              @change="onIconStyleChange"
              :options="iconStyleOptions"
              class="w-56"
            />
            <AppHelp text="影响侧边栏导航图标显示风格" aria-label="图标样式说明" />
          </div>

          <!-- 标题栏/侧边栏毛玻璃配色切换 -->
          <div class="flex items-center gap-4 mb-6">
            <label class="text-sm font-medium text-text w-16 flex-shrink-0">顶栏配色</label>
            <AppSelect
              v-model="topbarColor"
              @change="onTopbarColorChange"
              :options="topbarColorOptions"
              class="w-56"
            />
            <AppHelp text="标题栏与侧边栏的毛玻璃底色（深蓝 / 白色调）" aria-label="顶栏配色说明" />
          </div>

          <!-- 日夜模式 + 跟随系统（同一组：组内紧凑，上下留白更大，与相邻设置分开；仅支持夜间配色的主题显示） -->
          <div v-if="nightSupported" class="py-6 my-8 space-y-4">
            <div class="flex items-center gap-4">
              <label class="text-sm font-medium text-text w-16 flex-shrink-0">日夜模式</label>
              <ViewSwitch :modelValue="pendingMode" :options="modeSwitchOptions" @update:modelValue="onSelectMode" />
              <AppHelp text="当前主题支持夜间配色" aria-label="日夜模式说明" />
            </div>
            <div class="flex items-center gap-4">
              <label class="text-sm font-medium text-text w-16 flex-shrink-0">跟随系统</label>
              <AppSwitch :model-value="followSystem" aria-label="跟随系统" @change="onFollowSystemChange" />
              <AppHelp text="开启后按操作系统的深色/浅色偏好自动切换" aria-label="跟随系统说明" />
            </div>
          </div>

          <!-- 提示合并 -->
          <div class="flex items-center gap-4 mb-6">
            <label class="text-sm font-medium text-text w-16 flex-shrink-0">提示合并</label>
            <AppSwitch :model-value="mergeNotifications" aria-label="提示合并" @change="onMergeNotificationsChange" />
            <AppHelp text="相同类型的重复提示合并为一条并计数，避免遮挡页面" aria-label="提示合并说明" />
          </div>

          <!-- 动画效果总开关 -->
          <div class="flex items-center gap-4 mb-6">
            <label class="text-sm font-medium text-text w-16 flex-shrink-0">动画效果</label>
            <AppSwitch :model-value="animationsEnabled" aria-label="动画效果" @change="onAnimationsChange" />
            <AppHelp text="关闭后禁用全部过渡与动画（含窗口淡入淡出、弹窗与列表动效）" aria-label="动画效果说明" />
          </div>

          <!-- 背景图片（毛玻璃系主题：glass / glass2） -->
          <div v-if="isGlassTheme" class="border-t border-border pt-6 mt-6">
            <h3 class="text-lg font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="image" :size="18" /> 背景图片 <AppHelp text="支持 JPG / PNG / GIF / WebP，留空使用默认弥散光斑" aria-label="背景图片说明" /></h3>
            <div class="flex items-center gap-3 mb-2">
              <input
                ref="bgImageInput"
                type="file"
                accept="image/*"
                @change="onBgImageFileChange"
                class="hidden"
              />
              <button @click="pickBgImage" class="bg-info hover:bg-info-hover text-text-inverse px-4 py-2 rounded transition-theme whitespace-nowrap flex items-center gap-1.5"><IconGlyph name="folder" :size="14" tint="current" /> 选择本地图片</button>
              <span v-if="bgImageFileName" class="text-sm text-text-secondary">已选: {{ bgImageFileName }}</span>
              <button v-if="bgImageUrl" @click="clearBgImage" class="text-sm text-danger hover:underline">清除</button>
            </div>
            <div v-if="bgImageUrl" class="mt-3">
              <img :src="bgImagePreviewUrl" class="max-h-40 rounded border border-border object-cover shadow-sm" />
            </div>
          </div>

          <!-- 透明度设置（毛玻璃系主题：glass / glass2） -->
          <div v-if="isGlassTheme" class="border-t border-border pt-6 mt-6">
            <h3 class="text-lg font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="sliders" :size="18" /> 透明度设置</h3>
            <div class="space-y-5">
              <div>
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <label class="text-sm font-medium text-text">背景遮罩层（有自定义背景图时）</label>
                    <AppHelp text="数值越高，背景图越不明显；越低，背景图越清晰" aria-label="背景遮罩层说明" />
                  </div>
                  <span class="text-xs text-text-muted">{{ Math.round(bgMaskOpacity * 100) }}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  :value="bgMaskOpacity"
                  @input="onBgMaskOpacityChange"
                  class="w-full"
                />
              </div>
              <div>
                <div class="flex items-center justify-between mb-1">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <label class="text-sm font-medium text-text">组件透明玻璃层</label>
                    <AppHelp text="控制卡片、表格、通知弹窗等玻璃层的透明度" aria-label="组件透明玻璃层说明" />
                  </div>
                  <span class="text-xs text-text-muted">{{ Math.round(glassOpacity * 100) }}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  :value="glassOpacity"
                  @input="onGlassOpacityChange"
                  class="w-full"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

    <!-- ========== 工具箱设置 ========== -->
    <div class="mb-6">
      <h2 id="settings-section-toolbox" class="text-xl font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="toolbox" :size="20" /> 工具箱设置</h2>
      <div class="bg-surface rounded-lg border border-border p-6">
        <div class="flex items-center gap-4">
          <div class="w-40 flex-shrink-0 flex items-center gap-1.5">
            <label class="text-sm font-medium text-text">是否启用工具箱</label>
            <AppHelp text="关闭后立即隐藏工具箱并释放其窗口，下次启动也不再显示；开启立即显示" aria-label="是否启用工具箱说明" />
          </div>
          <AppSwitch :model-value="toolboxEnabled" aria-label="是否启用工具箱" @change="onToolboxChange" />
        </div>
        <div class="flex items-center gap-4 mt-6">
          <div class="w-40 flex-shrink-0 flex items-center gap-1.5">
            <label class="text-sm font-medium text-text">新U盘插入自动打开</label>
            <AppHelp text="插入新U盘时自动用文件资源管理器打开（仅Windows，即时生效）" aria-label="新U盘插入自动打开说明" />
          </div>
          <AppSwitch :model-value="usbAutoOpen" aria-label="新U盘插入自动打开" @change="onUsbAutoOpenChange" />
        </div>
      </div>
    </div>

    <!-- ========== 桌面小组件设置 ========== -->
    <div class="mb-6">
      <h2 id="settings-section-widget" class="text-xl font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="monitor" :size="20" /> 桌面小组件设置</h2>
      <div class="bg-surface rounded-lg border border-border p-6">
        <div class="flex items-center gap-4">
          <div class="w-40 flex-shrink-0 flex items-center gap-1.5">
            <label class="text-sm font-medium text-text">启用桌面小组件</label>
            <AppHelp text="关闭后启动不创建桌面小组件窗口（更省资源），并可立即关闭当前窗口；开启立即显示" aria-label="启用桌面小组件说明" />
          </div>
          <AppSwitch :model-value="desktopWidgetEnabled" aria-label="启用桌面小组件" @change="onDesktopWidgetChange" />
        </div>
        <p class="text-xs text-text-muted mt-2 ml-40">
          组件固定常驻所有窗口之下（桌面图标之上）：不会被其它应用窗口盖住，点击也不会把窗口抬到最前面，
          仍可点击、可拖动；位置会记住，下次启动回到原处。
        </p>
      </div>
    </div>

    <!-- ========== 性能 ========== -->
    <div class="mb-6">
      <h2 id="settings-section-perf" class="text-xl font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="sliders" :size="20" /> 性能</h2>
      <div class="bg-surface rounded-lg border border-border p-6">
        <!-- 四列等宽：前端 / 后端 / 小组件 / 全局（名称 / 状态 / 按钮 纵向排列） -->
        <div class="grid grid-cols-4 gap-4">
          <div class="flex flex-col items-center gap-2 rounded-lg border border-border bg-bg p-4">
            <span class="text-sm text-text-muted">前端</span>
            <span class="text-sm font-medium" :class="perfAlive.front ? 'text-text' : 'text-text-muted'">{{ perfAlive.front ? '正常' : '未运行' }}</span>
            <button @click="restartFrontend" class="bg-info hover:bg-info-hover text-text-inverse border border-border px-3 py-1.5 rounded text-sm transition-theme">重启前端</button>
          </div>
          <div class="flex flex-col items-center gap-2 rounded-lg border border-border bg-bg p-4">
            <span class="text-sm text-text-muted">后端</span>
            <span class="text-sm font-medium" :class="perfAlive.backend ? 'text-text' : 'text-text-muted'">{{ perfAlive.backend ? '正常' : '未运行' }}</span>
            <button @click="restartBackend" :disabled="busyRestartBackend" class="bg-info hover:bg-info-hover text-text-inverse border border-border px-3 py-1.5 rounded text-sm transition-theme disabled:opacity-50">{{ busyRestartBackend ? '重启中…' : '重启后端' }}</button>
          </div>
          <div class="flex flex-col items-center gap-2 rounded-lg border border-border bg-bg p-4">
            <span class="text-sm text-text-muted">小组件</span>
            <span class="text-sm font-medium" :class="perfAlive.widget ? 'text-text' : 'text-text-muted'">{{ perfAlive.widget ? '正常' : '未运行' }}</span>
            <button @click="restartWidget" :disabled="busyRestartWidget" class="bg-info hover:bg-info-hover text-text-inverse border border-border px-3 py-1.5 rounded text-sm transition-theme disabled:opacity-50">{{ busyRestartWidget ? '重启中…' : '重启小组件' }}</button>
          </div>
          <div class="flex flex-col items-center gap-2 rounded-lg border border-border bg-bg p-4">
            <span class="text-sm text-text-muted">全局</span>
            <span class="text-sm font-medium" :class="perfAllAlive ? 'text-text' : 'text-text-muted'">{{ perfAllAlive ? '正常' : '部分未启动' }}</span>
            <button @click="restartAll" :disabled="busyRestartAll" class="bg-info hover:bg-info-hover text-text-inverse border border-border px-3 py-1.5 rounded text-sm transition-theme disabled:opacity-50">{{ busyRestartAll ? '重启中…' : '全部重启' }}</button>
          </div>
        </div>

        <!-- 内存占用：顶部为总计/平均/最高汇总，下方逐进程一条，条形宽度带过渡 -->
        <div class="border-t border-border pt-6 mt-6">
          <div class="flex items-center justify-between mb-3">
            <span class="text-sm font-medium text-text">内存占用</span>
            <button @click="recycleAll" :disabled="busyGc" class="w-24 text-center bg-primary hover:bg-primary-hover text-text-inverse px-4 py-1.5 rounded text-sm transition-theme disabled:opacity-50">{{ busyGc ? '回收中…' : '回收' }}</button>
          </div>
          <div class="flex items-center justify-between gap-x-2 mb-4 text-sm text-text text-center" style="font-variant-numeric: tabular-nums;">
            <span>总计 {{ fmtMem(perfTotal) }}</span>
            <span class="text-text-muted">|</span>
            <span>平均 {{ fmtMem(perfAvg) }}</span>
            <span class="text-text-muted">|</span>
            <span>最高 {{ fmtMem(perfMax) }}</span>
            <span class="text-text-muted">|</span>
            <span>前端 {{ fmtMem(perfFront) }}</span>
            <span class="text-text-muted">|</span>
            <span>后端 {{ fmtMem(perfBackend) }}</span>
            <span class="text-text-muted">|</span>
            <span>其他 {{ fmtMem(perfOther) }}</span>
          </div>
          <div class="space-y-3">
            <div v-for="row in perfRows" :key="row.key" class="flex items-center gap-3">
              <span class="w-32 flex-shrink-0 truncate text-sm text-text-secondary" :title="row.name">{{ row.name }}</span>
              <div class="flex-1 h-2.5 rounded-full bg-bg border border-border overflow-hidden">
                <div class="h-full rounded-full bg-primary" :style="{ width: barPct(row.memKB) + '%', transition: 'width 480ms cubic-bezier(0.4, 0, 0.2, 1), background-color 250ms' }"></div>
              </div>
              <span class="w-20 flex-shrink-0 text-right text-sm text-text" style="font-variant-numeric: tabular-nums;">{{ fmtMem(row.memKB) }}</span>
            </div>
          </div>
        </div>

        <!-- 空间管理：磁盘占用彩条（一段一类）+ 图例给数值与占比 -->
        <div class="border-t border-border pt-6 mt-6">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-1.5">
              <span class="text-sm font-medium text-text">空间管理</span>
              <AppHelp
                text="统计本身只读，不会删除任何文件。「图片微缩图」后面的两个按钮都是显式操作：「清理」删全部缓存（下次查看会重建），「回收」只删没有索引引用的孤儿、保留正在用的图，且会先报数再等确认。口径：软件本体＝程序安装目录（exe 与 resources）；该账号数据＝当前账号库文件（含 -wal/-shm）；其他账号数据＝其余账号库文件；图片微缩图＝缩略图目录（所有账号合计）；其他＝上传附件、相册回收站、快照与日志。"
                aria-label="空间管理统计口径说明"
                :size="13"
              />
            </div>
            <button
              @click="loadDiskUsage(true)"
              :disabled="busyDisk"
              class="w-24 text-center bg-bg hover:bg-surface-hover text-text border border-border px-4 py-1.5 rounded text-sm transition-theme disabled:opacity-50"
            >{{ busyDisk ? '统计中…' : '重新统计' }}</button>
          </div>
          <div v-if="diskSegments.length" class="space-y-3">
            <div class="flex items-center gap-3">
              <!-- key 用统计时间：每次「重新统计」换一份彩条，入场展开动画重播一次 -->
              <div
                :key="diskUsage.at"
                class="disk-bar flex-1 h-5 rounded-full overflow-hidden flex bg-bg border border-border"
                @mouseleave="hideDiskTip()"
              >
                <div
                  v-for="seg in diskSegments"
                  :key="seg.key"
                  class="h-full disk-seg"
                  :class="selectedDiskSegment && selectedDiskSegment.key === seg.key ? 'disk-seg-active' : (selectedDiskSegment ? 'disk-seg-dim' : '')"
                  :style="{ flex: `0 0 ${seg.pct}%`, background: seg.color }"
                  :title="`${seg.label} ${fmtBytes(seg.bytes)}（${seg.pctText}）`"
                  @mousemove="showDiskTip(seg, $event)"
                  @click="selectDiskSegment(seg.key)"
                ></div>
              </div>
              <span class="w-20 flex-shrink-0 text-right text-sm text-text" style="font-variant-numeric: tabular-nums;">{{ fmtBytes(diskUsage.total) }}</span>
            </div>
            <!-- 跟随鼠标的悬浮详情：Teleport 到 body + 行内 fixed（毛玻璃主题会改 .bg-surface 定位），
                 pointer-events-none 免得浮层吞掉 mousemove 造成闪烁 -->
            <Teleport to="body">
              <div
                v-if="diskTip"
                class="disk-tip fixed z-[10002] bg-surface rounded-lg shadow-card border border-border px-3 py-2 pointer-events-none"
                :style="{ position: 'fixed', left: diskTip.x + 'px', top: diskTip.y + 'px', width: '216px' }"
              >
                <div class="flex items-center gap-2">
                  <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" :style="{ background: diskTip.seg.color }"></span>
                  <span class="min-w-0 truncate text-sm font-medium text-text" :title="diskTip.seg.label">{{ diskTip.seg.label }}</span>
                </div>
                <div class="flex items-baseline justify-between mt-1.5">
                  <span class="text-xl font-medium text-text" style="font-variant-numeric: tabular-nums;">{{ diskTip.seg.pctText }}</span>
                  <span class="text-sm text-text-secondary" style="font-variant-numeric: tabular-nums;">{{ fmtBytes(diskTip.seg.bytes) }}</span>
                </div>
                <div class="h-1 rounded-full bg-border overflow-hidden mt-2">
                  <div class="h-full rounded-full" :style="{ width: diskTip.seg.pct + '%', background: diskTip.seg.color }"></div>
                </div>
                <div class="text-xs text-text-muted mt-1.5">共 {{ fmtBytes(diskUsage.total) }}</div>
              </div>
            </Teleport>
            <div class="grid grid-cols-2 gap-x-6 gap-y-2">
              <!-- 按钮紧跟文字（清的是文件不是索引，album_photos 一行不动），
                   后面用可伸缩空白把数值/占比顶到行尾，保证左右两列仍然对齐。
                   整行可点选，按钮用 .stop 免得顺带改变选中项。 -->
              <div
                v-for="seg in diskSegments"
                :key="seg.key"
                class="disk-legend-row flex items-center gap-2 min-w-0 rounded px-1 -mx-1 cursor-pointer hover:bg-surface-hover"
                :class="selectedDiskSegment && selectedDiskSegment.key === seg.key ? 'bg-surface-hover' : ''"
                @mousemove="showDiskTip(seg, $event)"
                @mouseleave="hideDiskTip()"
                @click="selectDiskSegment(seg.key)"
              >
                <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" :style="{ background: seg.color }"></span>
                <span class="min-w-0 truncate text-sm text-text-secondary" :title="seg.label">{{ seg.label }}</span>
                <button
                  v-if="seg.key === 'thumbs'"
                  @click.stop="purgeThumbs"
                  :disabled="busyPurgeThumbs || busyDisk"
                  class="flex-shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded border border-border bg-bg hover:bg-surface-hover text-text-secondary hover:text-text transition-theme disabled:opacity-50"
                  title="删除所有账号的图片微缩图缓存文件；照片与相册索引不受影响，下次查看时自动重建。旁边的「整理」只删孤儿、保留正在用的图"
                >{{ busyPurgeThumbs ? '清理中' : '清理' }}</button>
                <button
                  v-if="seg.key === 'thumbs'"
                  @click.stop="sweepThumbs"
                  :disabled="busySweepThumbs || busyPurgeThumbs || busyDisk"
                  class="flex-shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded border border-border bg-bg hover:bg-surface-hover text-text-secondary hover:text-text transition-theme disabled:opacity-50"
                  title="只整理没有索引引用的孤儿微缩图；正在使用的缩略图、照片和索引都不受影响"
                >{{ busySweepThumbs ? '整理中' : '整理' }}</button>
                <button
                  v-if="seg.key === 'logs'"
                  @click.stop="clearLogs"
                  :disabled="busyLogs || busyDisk"
                  class="flex-shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded border border-border bg-bg hover:bg-surface-hover text-text-secondary hover:text-text transition-theme disabled:opacity-50"
                  title="清空后端、启动、INP、桌面挂件四个日志文件（只截断不删文件）；不影响任何数据和照片，运行期的日志会继续照常写入"
                >{{ busyLogs ? '清理中' : '清理' }}</button>
                <button
                  v-if="seg.key === 'currentAccount'"
                  @click.stop="vacuumDb"
                  :disabled="busyVacuum || busyDisk"
                  class="flex-shrink-0 whitespace-nowrap text-xs px-1.5 py-0.5 rounded border border-border bg-bg hover:bg-surface-hover text-text-secondary hover:text-text transition-theme disabled:opacity-50"
                  title="整理当前账号的库文件：把删除记录后留下的空闲页真正还给磁盘（VACUUM）；整理期间应用会短暂无响应，数据与照片都不受影响"
                >{{ busyVacuum ? '整理中' : '整理' }}</button>
                <span class="flex-1"></span>
                <span class="text-sm text-text" style="font-variant-numeric: tabular-nums;">{{ fmtBytes(seg.bytes) }}</span>
                <span class="w-11 text-right text-xs text-text-muted" style="font-variant-numeric: tabular-nums;">{{ seg.pctText }}</span>
              </div>
            </div>
          </div>
          <p v-else class="text-sm text-text-muted">{{ busyDisk ? '正在统计磁盘占用…' : (diskUsageError || '暂无数据') }}</p>
        </div>

        <!-- 启动相关：快速启动开关 + 上次启动耗时（同一区块，共用一条分隔线） -->
        <div class="border-t border-border pt-6 mt-6 space-y-4">
          <div class="flex items-center gap-4">
            <div class="w-40 flex-shrink-0 flex items-center gap-1.5">
              <span class="text-sm font-medium text-text">快速启动</span>
              <AppHelp
                text="开启：占位页在界面元素（路由与样式）就绪时立即让位，首页数据边加载边显示，各卡片先显示加载中；关闭：等首页数据全部返回后才显示首页，整窗会多被占位页多挡一段接口往返。改动在下次启动生效。"
                aria-label="快速启动说明"
              />
            </div>
            <AppSwitch :model-value="fastStartup" aria-label="快速启动" @change="onFastStartupChange" />
            <span class="text-xs text-text-muted">下次启动生效</span>
          </div>
          <div class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <span class="text-sm text-text-muted">上次启动耗时</span>
              <AppHelp text="口径：进程启动到占位页移除（首屏内容真正绘制出来的那一刻），与 startup.log 同一口径" aria-label="启动耗时口径说明" :size="13" />
            </div>
            <span class="text-sm font-medium text-text" style="font-variant-numeric: tabular-nums;">{{ (perfStartupTotal / 1000).toFixed(3) }} s</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 保存路径设置 ========== -->
    <div class="mb-6">
      <h2 id="settings-section-savepath" class="text-xl font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="folder" :size="20" /> 保存路径设置</h2>
      <div class="bg-surface rounded-lg border border-border p-6 space-y-6">
        <div>
          <div class="flex items-center gap-4 mb-2">
            <div class="w-40 flex-shrink-0 flex items-center gap-1.5">
              <label class="text-sm font-medium text-text">注释截屏保存位置</label>
              <AppHelp text="注释工具保存截图的目录，留空则使用默认位置" aria-label="注释截屏保存位置说明" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="truncate text-sm text-text-secondary border border-border bg-bg px-3 py-2 rounded-lg" :title="noteSavePath || screenshotDir">{{ noteSavePath || screenshotDir }}</div>
            </div>
            <button @click="selectFolder('note')" class="bg-info hover:bg-info-hover text-text-inverse px-4 py-2 rounded transition-theme whitespace-nowrap">修改</button>
            <button @click="openDir(noteSavePath || screenshotDir)" class="bg-success hover:bg-success-hover text-text-inverse px-4 py-2 rounded transition-theme whitespace-nowrap">打开文件夹</button>
          </div>
        </div>
        <div>
          <div class="flex items-center gap-4 mb-2">
            <div class="w-40 flex-shrink-0 flex items-center gap-1.5">
              <label class="text-sm font-medium text-text">一键截屏保存位置</label>
              <AppHelp text="一键截屏工具保存截图的目录，留空则使用默认位置" aria-label="一键截屏保存位置说明" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="truncate text-sm text-text-secondary border border-border bg-bg px-3 py-2 rounded-lg" :title="screenshotSavePath || screenshotDir">
                {{ screenshotSavePath || screenshotDir }}
              </div>
            </div>
            <button @click="selectFolder('screenshot')" class="bg-info hover:bg-info-hover text-text-inverse px-4 py-2 rounded transition-theme whitespace-nowrap">修改</button>
            <button @click="openDir(screenshotSavePath || screenshotDir)" class="bg-success hover:bg-success-hover text-text-inverse px-4 py-2 rounded transition-theme whitespace-nowrap">打开文件夹</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 数据目录设置 ========== -->
    <div class="mb-6">
      <h2 id="settings-section-datadir" class="text-xl font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="box" :size="20" /> 数据目录设置</h2>
      <div class="bg-surface rounded-lg border border-border p-6 space-y-6">
        <div>
          <div class="flex items-center gap-4 mb-2">
            <label class="text-sm font-medium text-text w-40 flex-shrink-0">数据目录</label>
            <div class="flex-1 min-w-0">
              <div class="truncate text-sm text-text-secondary border border-border bg-bg px-3 py-2 rounded-lg" :title="dataDir">
                {{ dataDir || '加载中…' }}
              </div>
            </div>
            <button @click="changeDataDir" :disabled="busyDataDir" class="bg-info hover:bg-info-hover text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-50 whitespace-nowrap">
              {{ busyDataDir ? '搬迁中…' : '修改' }}
            </button>
            <button @click="openDir(dataDir)" :disabled="busyDataDir" class="bg-success hover:bg-success-hover text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-50 whitespace-nowrap">打开文件夹</button>
          </div>
          <p class="text-xs text-text-muted ml-40">全部本机数据的唯一根目录，修改会整体搬迁并重启应用服务。目录下按用途分四层，无需单独设置。</p>
          <p class="text-xs text-text-muted ml-40 mt-1">core（数据库与密钥）、content（上传图片、AI 技能、快照）、cache（相册缩略图等可再生缓存）、logs（运行日志）。</p>
        </div>
      </div>
    </div>

    <!-- ========== 数据管理 ========== -->
    <div class="mb-6">
      <h2 id="settings-section-data" class="text-xl font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="database" :size="20" /> 数据管理</h2>
      <DataExportPanel />
    </div>

    <!-- ========== 危险操作 ========== -->
    <div class="mb-6">
      <h2 id="settings-section-danger" class="text-xl font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="trash" :size="20" /> 危险操作</h2>
      <div class="bg-surface rounded-lg border border-border p-6 space-y-5">
        <div class="flex items-center justify-between flex-wrap gap-4">
          <div class="space-y-2 text-text-secondary">
            <p class="font-medium text-text">删除账号</p>
            <p class="text-sm text-text-muted">删除当前账号及其全部数据，操作不可恢复。</p>
          </div>
          <button @click="openDeleteAccount" class="bg-danger hover:bg-danger-hover text-text-inverse px-4 py-2 rounded transition-theme">删除账号</button>
        </div>
        <!-- 删除单个班级：多班级才给入口。它是「销毁一整套数据」，所以和删账号同列在危险区。
             样式与「删除账号」完全一致（同一套 bg-danger/hover/圆角/内边距）——
             两个都是不可恢复的破坏性操作，视觉上不该做出「一个更重一个更轻」的暗示。 -->
        <div v-if="classCount > 1" class="flex items-center justify-between flex-wrap gap-4 border-t border-border pt-5">
          <div class="space-y-2 text-text-secondary">
            <p class="font-medium text-text">删除该班级</p>
            <p class="text-sm text-text-muted">
              只删除当前班级的数据（学生、成绩、班费、相册……），其它班级不受影响，操作不可恢复。
            </p>
          </div>
          <button @click="openDeleteClass"
            class="bg-danger hover:bg-danger-hover text-text-inverse px-4 py-2 rounded transition-theme">删除该班级</button>
        </div>
      </div>
    </div>

    <!-- 内嵌弹窗：修改用户名 -->
    <Teleport to="body">
    <Transition name="dialog">
      <div v-if="modalType === 'username'" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001]" @click.self="closeModal">
        <div class="dialog-card bg-surface rounded-lg p-6 w-96 border border-border shadow-lg">
            <h3 class="text-lg font-bold text-text mb-4">修改用户名</h3>
            <input v-model="newUsername" placeholder="新用户名" class="border border-border bg-surface text-text p-2 w-full mb-3 rounded" @keydown.enter="changeUsername" />
            <!-- 明文 / 无密码两档没有登录密码可校验，这两档下不出现密码框（后端对空 password 本就直接放行） -->
            <input v-if="hasLoginPassword" v-model="usernamePassword" type="password" placeholder="当前密码" autocomplete="current-password" class="border border-border bg-surface text-text p-2 w-full mb-3 rounded" @keydown.enter="changeUsername" />
            <p v-if="usernameError" class="text-sm text-danger mb-3">{{ usernameError }}</p>
            <div class="flex justify-end gap-2">
              <button @click="closeModal" :disabled="busyUsername" class="bg-surface-hover text-text px-4 py-2 rounded border border-border transition-theme disabled:opacity-50">取消</button>
              <button @click="changeUsername" :disabled="busyUsername" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-50">{{ busyUsername ? '提交中…' : '确认修改' }}</button>
            </div>
        </div>
      </div>
    </Transition>
    </Teleport>

    <!-- 内嵌弹窗：修改密码 -->
    <Teleport to="body">
    <Transition name="dialog">
      <div v-if="modalType === 'password'" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001]" @click.self="closeModal">
        <div class="dialog-card bg-surface rounded-lg p-6 w-96 border border-border shadow-lg">
            <h3 class="text-lg font-bold text-text mb-4">修改密码</h3>
            <input v-model="oldPassword" type="password" placeholder="原密码" autocomplete="current-password" class="border border-border bg-surface text-text p-2 w-full mb-3 rounded" @keydown.enter="changePassword" />
            <input v-model="newPassword" type="password" placeholder="新密码（至少 6 位）" autocomplete="new-password" class="border border-border bg-surface text-text p-2 w-full mb-3 rounded" @keydown.enter="changePassword" />
            <!-- 二次确认：打错一个字就要走找回流程，挡的是手误；提示语按当前等级分开
                 （普通密码可在原机本机信息恢复，超级隐私只有恢复词，见 changePwdHint） -->
            <input v-model="confirmPassword" type="password" placeholder="再次输入新密码" autocomplete="new-password" class="border border-border bg-surface text-text p-2 w-full mb-1 rounded" @keydown.enter="changePassword" />
            <!-- 输入过程不实时提示「一致 / 不一致」：边打字边跳色的提示太吵，只在提交时校验 -->
            <p class="text-xs text-text-muted mb-3">{{ changePwdHint }}</p>
            <!-- 服务端错误就地显示：用 alert 会把用户弹出的输入内容一起清掉，得从头再填一遍 -->
            <p v-if="pwdError" class="text-sm text-danger mb-3">{{ pwdError }}</p>
            <div class="flex items-center justify-between gap-2">
              <!-- 忘记密码：已登录但记不住原密码时的退路。入口只在有登录密码的档位出现
                   （与「修改密码」按钮同条件），点了不列账号，直接验证当前账号的本机库 -->
              <button type="button" @click="openLocalRecover" class="text-xs text-text-muted underline hover:text-text transition-theme">忘记密码？</button>
              <div class="flex gap-2">
                <button @click="closeModal" :disabled="busyPwd" class="bg-surface-hover text-text px-4 py-2 rounded border border-border transition-theme disabled:opacity-50">取消</button>
                <button @click="changePassword" :disabled="busyPwd" class="bg-info hover:bg-info-hover text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-50">{{ busyPwd ? '提交中…' : '确认修改' }}</button>
              </div>
            </div>
        </div>
      </div>
    </Transition>
    </Teleport>

    <!-- 内嵌弹窗：导出数据库 -->
    <Teleport to="body">
    <Transition name="dialog">
      <div v-if="modalType === 'export'" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10001]" @click.self="closeModal">
        <div class="dialog-card bg-surface rounded-lg p-6 w-96 border border-border shadow-lg">
          <h3 class="text-lg font-bold text-text mb-4">导出数据库</h3>
          <p class="text-xs text-text-muted mb-3">导出当前账号的全部内容（业务数据 + 应用设置 + 账号 + 收据原件等文件）为 ZIP 备份包，换机后用对应的密码恢复。</p>
          <!-- 无密码账号（明文 / 免密）不设密码，摆一个密码框只会让人以为「必须填点什么」 -->
          <input v-if="hasLoginPassword" v-model="exportPassword" type="password" placeholder="登录密码（只有本人能导出）" autocomplete="current-password" class="border border-border bg-surface text-text p-2 w-full mb-3 rounded" />
          <template v-if="dbEncrypted">
            <!-- 底部间距交给容器：勾选框 / 输入框 / 提示语的显隐组合有好几种，
                 逐个加 mb-4 必然出现「少显示一个就多一截空白」 -->
            <div class="mb-4">
              <label class="flex items-center gap-2 text-sm text-text mb-2 cursor-pointer select-none">
                <input type="checkbox" v-model="exportEncrypt" class="w-4 h-4 accent-warning" />
                数据库密码加密导出
              </label>
              <input v-if="exportEncrypt" v-model="exportDbPwd" type="password" :placeholder="hasLoginPassword ? '数据库密码（留空则用登录密码）' : '请设置导出密码（换机恢复时要输）'" autocomplete="new-password" class="border border-border bg-surface text-text p-2 w-full rounded" />
              <!-- 没有登录密码时，这个导出密码就是换机恢复的**唯一凭证**；包里不存它，丢了就打不开 -->
              <p v-if="!hasLoginPassword && exportEncrypt" class="text-xs text-text-muted mt-2">该账号没有登录密码，导出密码不会存进备份包，换机恢复时要用它解开 —— 请记牢。</p>
            </div>
          </template>
          <p v-else class="text-xs text-text-muted mb-4">当前数据库未加密，导出的备份包为明文，无需设置导出密码。</p>
          <div class="flex justify-end gap-2">
            <button @click="closeModal" class="bg-surface-hover text-text px-4 py-2 rounded border border-border transition-theme">取消</button>
            <button @click="exportDb" :disabled="busyExport" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded transition-theme disabled:opacity-50">
              {{ busyExport ? (exportProgress ? `导出中… ${(exportProgress / 1048576).toFixed(1)} MB` : '导出中…') : '导出备份' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
    </Teleport>

    <ConfirmDialog
      v-if="dialogMounted"
      :visible="dialog.visible"
      :title="dialog.title"
      :message="dialog.message"
      :type="dialog.type"
      :showCancel="dialog.showCancel"
      :confirmText="dialog.confirmText"
      :confirmDisabled="dialog.confirmDisabled"
      @confirm="onDialogConfirm"
      @cancel="onDialogCancel"
    />

    <!-- 整理数据库期间：复用统一的确认框外壳（不另写遮罩），只做进度提示。
         「取消」只关进度框、不中止后端 —— VACUUM 是 better-sqlite3 的同步原生调用，
         执行期间后端连 IPC 都处理不了，真正可中止只能把 VACUUM 放进 worker 线程后强杀，
         代价是留下需要回滚的热日志，暂不做；所以按钮文案是「取消」而非「停止」。
         关掉后 busyVacuum 仍为 true，整理按钮保持禁用，避免再排一次整理。 -->
    <ConfirmDialog
      v-if="vacuumDialog"
      :visible="true"
      title="正在整理数据库"
      :message="vacuumProgressText"
      :showCancel="true"
      cancelText="取消"
      :confirmDisabled="true"
      confirmText="整理中…"
      @cancel="cancelVacuumWait"
    />

    <!-- 班级切换弹窗：与首页齿轮打开的是同一个组件，但这里是「只做切换」——
         口号/班风/学风是首页展示文案，从设置页点「切换」时摆出来是多余的。 -->
    <ClassInfoDialog
      :visible="classDialogVisible"
      :class-data="classInfo"
      :classes="classList"
      :current-slug="currentSlug"
      :switching="switchingClass"
      switch-only
      @confirm="saveClassInfoFromSettings"
      @cancel="classDialogVisible = false"
      @switch-class="switchClassFromSettings"
      @create-class="createClassFromSettings"
      @rename-class="renameClassFromSettings"
    />
  </div>
</template>

<script setup vapor>
import { getCurrentUser } from '../../utils/authStorage.js'
import { ref, computed, watch, onMounted, onActivated, onDeactivated, onBeforeUnmount, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHelp from '../../components/base/AppHelp.vue'
import CustomScrollbar from '../../components/base/CustomScrollbar.vue'
import AppSelect from '../../components/base/AppSelect.vue'
import ClassInfoDialog from '../../components/dialogs/ClassInfoDialog.vue'
import AppSwitch from '../../components/base/AppSwitch.vue'
import ViewSwitch from '../../components/base/ViewSwitch.vue'
import DataExportPanel from '../../components/data-manage/DataExportPanel.vue'
import { useThemeStore } from '../../stores/theme'
import { storeToRefs } from 'pinia'
import { resourceUrl } from '../../utils/apiUrl'
// 班级弹窗的显隐跨视图重建保留（切班/建班会重建整个视图，见 utils/classScope.js）
import { settingsClassDialogOpen } from '../../utils/classScope.js'
import { readFastStartup } from '../../utils/fastStartup.js'
import { useDisposables } from '../../utils/disposables.js'
import '../../styles/dialog-transition.css'
import { useSettingsSearch } from './SettingsView.search.js'
import { useSettingsData } from './SettingsView.data.js'
import { useSettingsAppearance } from './SettingsView.appearance.js'
import { RECEIVE } from '../../electronChannels.js'
import { useNotification } from '../../composables/useNotification.js'

// 弹窗类组件懒加载：打开时才加载对应 chunk
const ConfirmDialog = defineAsyncComponent(() => import('../../components/base/ConfirmDialog.vue'))
// 恢复词弹窗：注册与「切到超级隐私」共用，同样按 chunk 懒加载（只有切等级时才会用到）
const RecoveryKeyDialog = defineAsyncComponent(() => import('../../components/dialogs/RecoveryKeyDialog.vue'))
// 忘记密码弹窗：只有点「修改密码 → 忘记密码？」时才需要，同样懒加载
const LocalRecoverDialog = defineAsyncComponent(() => import('../../components/dialogs/LocalRecoverDialog.vue'))

const route = useRoute()
const router = useRouter()
const themeStore = useThemeStore()
const { currentTheme, allThemes, bgMaskOpacity, glassOpacity, iconStyle, topbarColor, animationsEnabled, pendingMode, nightSupported, followSystem } = storeToRefs(themeStore)

// 模板 ref（搜索输入/弹窗、背景图 file input）
const settingsSearchInput = ref(null)
const settingsSearchPopup = ref(null)
const bgImageInput = ref(null)
// 触发隐藏的背景图 file input（「选择本地图片」按钮）：走模板 ref 变量，不用 $refs
function pickBgImage() {
  const el = bgImageInput.value
  if (el) el.click()
}

// 设置项搜索：输入即匹配，结果以悬浮弹窗显示在搜索框下方，点击滚动到对应设置区
const settingsSearch = ref('')
const settingsSearchOpen = ref(false)
// 悬浮弹窗的视口坐标（Teleport 到 body 后用 fixed 定位，需要手动计算）
const searchPopup = ref({ left: 0, top: 0, width: 0 })
// 搜索弹窗当前高亮项下标（方向键上下切换、回车跳转）
const searchActiveIndex = ref(0)
// py 为标题拼音首字母，让单个字母（如 z → 主题设置）也能命中
const settingsSections = ref([
  { key: 'account',  label: '账号管理',       py: 'zhgl' },
  { key: 'semester', label: '学期设置',       py: 'xqsz' },
  { key: 'undo',     label: '撤销记录',       py: 'cxjl' },
  { key: 'theme',    label: '主题设置',       py: 'ztsz' },
  { key: 'toolbox',  label: '工具箱设置',     py: 'gjxsz' },
  { key: 'widget',   label: '桌面小组件设置', py: 'zmxjjsz' },
  { key: 'perf',     label: '性能',           py: 'xn' },
  { key: 'savepath', label: '保存路径设置',   py: 'bcljsz' },
  { key: 'datadir',  label: '数据目录设置',   py: 'sjmlsz' },
  { key: 'data',     label: '数据管理',       py: 'sjgl' },
  { key: 'danger',   label: '危险操作',       py: 'wxcz' },
])
// 分区内的具体设置项：命中后滚动到该设置行（py 为标签拼音首字母）
const settingsItems = ref([
  { label: '选择学期',                 section: 'semester', py: 'xzq' },
  { label: '学期开始时间',             section: 'semester', py: 'xqkssj' },
  { label: '学期结束时间',             section: 'semester', py: 'xqjssj' },
  { label: '本学期时长',               section: 'semester', py: 'bxqsc' },
  { label: '主题',                     section: 'theme',    py: 'zt' },
  { label: '图标样式',                 section: 'theme',    py: 'tbys' },
  { label: '顶栏配色',                 section: 'theme',    py: 'dlps' },
  { label: '日夜模式',                 section: 'theme',    py: 'ryms' },
  { label: '跟随系统',                 section: 'theme',    py: 'gsxt' },
  { label: '提示合并',                 section: 'theme',    py: 'tshb' },
  { label: '动画效果',                 section: 'theme',    py: 'dhxg' },
  { label: '背景遮罩层（有自定义背景图时）', section: 'theme', py: 'bjzzc' },
  { label: '组件透明玻璃层',           section: 'theme',    py: 'zjtmlbl' },
  { label: '是否启用工具箱',           section: 'toolbox',  py: 'sfqygjx' },
  { label: '本次启用工具箱',           section: 'toolbox',  py: 'bcqygjx' },
  { label: '新U盘插入自动打开',        section: 'toolbox',  py: 'xupcrzddk' },
  { label: '启用桌面小组件',           section: 'widget',   py: 'qyzmxjjs' },
  { label: '注释截屏保存位置',         section: 'savepath', py: 'zsjpbcwz' },
  { label: '一键截屏保存位置',         section: 'savepath', py: 'yjjpbcwz' },
  { label: '数据库目录',               section: 'datadir',  py: 'sjkml' },
  { label: '相册缩略图缓存',           section: 'datadir',  py: 'xcsltch' },
  { label: '技能文件目录',             section: 'datadir',  py: 'jnwjml' },
  { label: '安全等级',                 section: 'account',  py: 'aqdj' },
  { label: '数据导出',                 section: 'data',     py: 'sjdc' },
  { label: '导出格式',                 section: 'data',     py: 'dcgs' },
  { label: 'zip 密码',                 section: 'data',     py: 'zipmm' },
])
// 图标样式选项：彩色图标 / Emoji
const iconStyleOptions = [
  { value: 'color', label: '彩色图标' },
  { value: 'emoji', label: 'Emoji' },
]
// 标题栏/侧边栏毛玻璃配色：深蓝（旧款）/ 白色调
const topbarColorOptions = [
  { value: 'blue', label: '深蓝' },
  { value: 'light', label: '白色调' },
]
// 日夜模式切换：日间 / 夜间（图标为标题栏同款太阳 / 月亮）
const modeSwitchOptions = [
  { value: 'day', label: '日间', icon: 'sun' },
  { value: 'night', label: '夜间', icon: 'moon' },
]
// Modal
const modalType = ref('')
const newUsername = ref('')
const usernamePassword = ref('')
const oldPassword = ref('')
const newPassword = ref('')
// 修改密码的三件配套：二次确认输入、弹窗内联错误、提交中锁。
// 打错一个字就得走找回流程（普通密码靠本机信息恢复、超级隐私只能靠恢复词），
// 这三样缺一都会让手误变成一次不必要的找回。
const confirmPassword = ref('')
const pwdError = ref('')
const busyPwd = ref(false)
// 修改用户名同样缺提交锁：点了没反应时用户会连点，请求发两次
const usernameError = ref('')
const busyUsername = ref(false)
// Export database
const exportPassword = ref('')
const exportEncrypt = ref(true)
const exportDbPwd = ref('')
const busyExport = ref(false)
// 导出是流式的、没有 Content-Length（边扫边写），所以报不了百分比；
// 但至少要把「已经写出多少」显示出来 —— 否则 GB 级备份期间用户会当成卡死并强杀进程。
const exportProgress = ref(0)
// 学期设置（多学期列表 + 当前学期；起止日期供座位快照按天结算）
const semesters = ref([])
const semesterId = ref(null)
const semesterNameDraft = ref('')
const showRenameSemester = ref(false)
const newSemesterName = ref('')
const showAddSemester = ref(false)
const showDeleteSemester = ref(false)
const busySemester = ref(false)
// 保存学期日期的独立 busy 标志：与 busySemester（增删学期）分开，
// 否则「保存日期」和「删除学期」会互相把对方的按钮置灰
const busySemesterDate = ref(false)
const semesterStart = ref('')
const semesterEnd = ref('')
// 学期日期的内联错误文案（保存失败时显示在输入框下方，不只靠 toast）
const semesterDateErrorText = ref('')
// Dialog
const dialog = ref({
  visible: false,
  message: '',
  type: 'alert',
  showCancel: false,
})
const dialogMounted = ref(false)
const dialogCallback = ref(null)
// 「删除账号」倒计时定时器
const deleteTimer = ref(null)
// 当前账号有几个班：决定危险区要不要出现「删除该班级」。
// 初始 0（= 未知）时按「不显示」处理，拉回来再显示 —— 宁可晚一帧出现，
// 也不要在单班账号上闪一个点下去必然被拒的按钮。
const classCount = ref(0)
// 账号信息区的「当前班级」：列表与当前 slug 同一次请求拿回来，
// 切换时只换 slug，不重新拉列表（切完会重建视图，onMounted 再拉一次）。
const classList = ref([])
const currentSlug = ref('')
const switchingClass = ref(false)
const currentClassName = computed(
  () => classList.value.find((c) => c.slug === currentSlug.value)?.className || ''
)
// 班级弹窗（与首页齿轮打开的是同一个组件）：显隐 + 弹窗里的班名/口号等。
// 显隐同步到模块级状态：切班/建班会重建整个视图，新实例靠它恢复弹窗；
// 与首页那份分开记，两边互不覆盖（见 utils/classScope.js 的说明）。
const classDialogVisible = ref(false)
watch(classDialogVisible, (v) => { settingsClassDialogOpen.value = v })
const classInfo = ref({ name: '', motto: '', mottoStyle: '', xuefeng: '' })
// 工具箱设置
const toolboxEnabled = ref(true)
const noteSavePath = ref('')
const screenshotSavePath = ref('')
const screenshotDir = ref('')
const usbAutoOpen = ref(false)
// 桌面小组件启用状态：localStorage 持久化，默认启用（主进程据此按需创建桌面小组件窗口）
const desktopWidgetEnabled = ref((localStorage.getItem('desktopWidgetEnabled') ?? '0') !== '0')
const loaded = ref(false)
const _fromMainHandler = ref(null)
// 数据目录（唯一可配置的目录）
const dataDir = ref('')
const busyDataDir = ref(false)
// 安全等级（仅当前账号）：plain / nopass / password / privacy
const securityLevel = ref('')
const securityLevelLoading = ref(true)
const busySecurityLevel = ref(false)
const securityDialog = ref({ open: false, target: '', password: '', newPassword: '', confirmPassword: '', error: '' })
const privacyPhrase = ref('')
// 恢复词弹窗按需挂载：没切过超级隐私就不加载它的 chunk；一旦挂载则保留（关闭走 visible，留住退场动画）
const recoveryMounted = ref(false)
watch(() => privacyPhrase.value, (v) => { if (v) recoveryMounted.value = true })
// 撤销记录
const undoGroups = ref([])
// 撤销记录列表滚动容器（自定义滚动条的目标）
const undoListRef = ref(null)
const busyUndo = ref(false)
// Theme
const selectedThemeId = ref('')
// 是否合并相同内容的重复提示
const mergeNotifications = ref(true)
// Background image
const bgImageUrl = ref('')
const bgImageFileName = ref('')
// 性能面板：逐进程内存列表 + 三个重启目标的存活状态
const perfProcs = ref([])
// 首位进程条形的目标占比（0.85~0.95）：让最高占用不固定满格，每次采样小幅跳动更自然
const perfTopRatio = ref(0.9)
const perfAlive = ref({ front: false, backend: false, widget: false })
// 性能面板：内存总计 / 近一分钟平均 / 自启动最高（均来自主进程采样，单位 KB）
// null 表示尚无数据，展示为占位符，避免出现误导性的 0 MB
const perfTotal = ref(null)
const perfAvg = ref(null)
const perfMax = ref(null)
// 按用途分组：前端（主窗口渲染进程）/ 后端 / 其他
const perfFront = ref(null)
const perfBackend = ref(null)
const perfOther = ref(null)
const perfStartupTotal = ref(0)
// 快速启动：占位页是否等首页数据（下次启动生效）。初值直接读 localStorage，
// 避免进页面先显示默认值再跳一下；读写单源见 utils/fastStartup.js。
const fastStartup = ref(readFastStartup())
// 空间管理：磁盘占用统计（主进程只读扫描，按四类 + 其他归账），null 表示还没扫过
const diskUsage = ref(null)
const diskUsageError = ref('')
const busyDisk = ref(false)
// 「清理微缩图」进行中：删几千个文件要几秒，期间按钮禁用避免重复点
const busyPurgeThumbs = ref(false)
const busySweepThumbs = ref(false)
// 「整理数据库」进行中：VACUUM 会独占库文件并阻塞后端，期间按钮禁用避免重复点
const busyVacuum = ref(false)
// 进度框是否可见：点「取消」只关它，busyVacuum 继续为 true（后台还在整理）
const vacuumDialog = ref(false)
// 「清理日志」进行中：四个日志文件逐个截断，期间按钮禁用避免重复点
const busyLogs = ref(false)
// 整理进度文案：ConfirmDialog 是 whitespace-pre-line，换行必须用 \n 而不是 <br>
const vacuumProgressText = '耗时与库大小成正比（约 3 秒/GB）。\n期间请勿操作，数据与照片不会丢失，完成后会自动刷新占用。'
const busyGc = ref(false)
const busyRestartBackend = ref(false)
const busyRestartWidget = ref(false)
const busyRestartAll = ref(false)
const _perfTimer = ref(null)

// 非响应式实例状态（动画帧/定时器句柄与搜索闪动标记）挂在 ctx 上单源共享

const user = computed(() => {
  return getCurrentUser()
})
// 安全等级下拉选项（与引导页同一套文案）
const securityLevelOptions = computed(() => {
  return [
    { value: 'plain', label: '明文模式（不加密）' },
    { value: 'nopass', label: '无密码模式（加密，免密登录）' },
    { value: 'password', label: '普通密码模式（加密 + 登录密码）' },
    { value: 'privacy', label: '超级隐私模式（密码 + 恢复词）' },
  ]
})
const securityLevelHint = computed(() => {
  if (securityLevelLoading.value) return '加载中…'
  if (busySecurityLevel.value) return '切换中…'
  if (securityLevel.value === 'plain') return '当前为明文，可升级为加密'
  return ''
})
// 兼容导出弹窗：除明文外都视为加密库
const dbEncrypted = computed(() => {
  return securityLevel.value !== 'plain'
})
// 当前等级是否需要登录密码：明文 / 无密码两档在切换时后端会把 users.password 置空
// （见 account.js 的 security-level 分支），因此没有「当前密码」可比对，也没有「修改密码」
// 这个动作可做（设密码的唯一入口是切换安全等级）。
// securityLevel 加载完成前是 ''，此时按「有密码」处理，避免界面先闪一下无密码态。
const hasLoginPassword = computed(() => {
  const lv = securityLevel.value
  return lv !== 'plain' && lv !== 'nopass'
})
const securityNeedsCurrent = computed(() => {
  return securityLevel.value === 'password' || securityLevel.value === 'privacy'
})
const securityNeedsNew = computed(() => {
  const t = securityDialog.value.target
  return !securityNeedsCurrent.value && (t === 'password' || t === 'privacy')
})
const securityDialogMessage = computed(() => {
  switch (securityDialog.value.target) {
    case 'plain':
      return '关闭加密后，数据库将以明文保存，任何能访问该文件的程序都能直接读取其中数据；此操作不可逆。'
    case 'nopass':
      return '改为无密码模式：数据库仍然加密，但登录不再需要密码，换机或换 Windows 账户后仍无法打开。'
    case 'password':
      return '改为普通密码模式：使用登录密码登录，数据库由本机主密钥自动解锁，不再需要恢复词。'
    case 'privacy':
      return '开启超级隐私模式后，库密钥只由「登录密码 + 12 词恢复词」包裹，忘记两者将永久无法恢复数据。'
    default:
      return ''
  }
})
// 忘记密码的退路随等级不同，两档不能共用一句提示：
// 普通密码库由本机主密钥包裹，可在原机走「忘记密码 → 使用本机信息恢复」（auth.js 的 db-recover，
// 要求原机 + 原 Windows 用户 + 库文件仍在）；超级隐私库没有主密钥包裹，本机恢复不适用，
// 唯一退路是恢复词。把这两档说成一样，会让用户误以为超级隐私也有本机退路。
const securityNewPwdHint = computed(() => (
  securityDialog.value.target === 'privacy'
    ? '恢复词只显示一次，务必先下载保存；密码与恢复词同时丢失将无法恢复数据。'
    : '请记牢：忘记密码可在原机走「忘记密码 → 使用本机信息恢复」；换机后无法找回。'
))
const changePwdHint = computed(() => (
  securityLevel.value === 'privacy'
    ? '改完请记牢：超级隐私模式忘记密码只能用恢复词找回。'
    : '忘记密码可以点击下面的按钮尝试恢复。'
))
// 主题下拉与主题选择器共用 store 的 allThemes，避免两处列表漂移
const themeOptions = computed(() => {
  return allThemes.value.map(t => ({ value: t.id, label: t.name }))
})
// 玻璃系主题（旧毛玻璃 / 新毛玻璃）共用「背景图片 + 透明度」两组设置
const isGlassTheme = computed(() => {
  return currentTheme.value === 'glass' || currentTheme.value === 'glass2'
})
// 设置项搜索结果：分区标题 + 分区内的具体设置项；关键字为空时全部列出
// 关键字按「标题文本 / 拼音首字母」匹配，单个汉字或单个字母都会即时搜索
// 渲染顺序为「先分区标题、再设置项」，逐条错开延迟直接取渲染下标 idx（见模板），
// 这样整份结果是一条连续的错开序列；行的 key 带关键字，每次搜索整批重新挂载，不会重启个别行。
const settingsSearchResults = computed(() => {
  const q = settingsSearch.value.trim().toLowerCase()
  const hit = (label, py) => !q || label.toLowerCase().includes(q) || py.includes(q)
  const sections = settingsSections.value
    .filter(s => hit(s.label, s.py))
    .map(s => ({ id: 'section:' + s.key, label: s.label, key: s.key, section: '' }))
  const items = settingsItems.value
    .filter(i => hit(i.label, i.py))
    .map(i => ({ id: 'item:' + i.section + ':' + i.label, label: i.label, key: i.section, section: i.section }))
  return [...sections, ...items]
})
// 学期下拉：值为学期 id，标签为学期名
const semesterOptions = computed(() => {
  return semesters.value.map(s => ({ value: s.id, label: s.name || '未命名学期' }))
})
// 当前选中的学期对象（未选中时取列表第一条）
const activeSemester = computed(() => {
  return semesters.value.find(s => s.id === semesterId.value) || semesters.value[0] || null
})
// 删除学期确认文案：点明删的是哪个学期，删的是当前学期时额外提示会自动切到其它学期
const deleteSemesterMessage = computed(() => {
  const cur = activeSemester.value
  if (!cur) return ''
  const name = cur.name || '未命名学期'
  // ConfirmDialog 用 whitespace-pre-line 渲染纯文本：换行用 \n，不能写 <br>
  const tail = cur.is_current && semesters.value.length > 1
    ? '\n它是当前学期，删除后会自动切换到其它学期。'
    : ''
  return `确定删除学期「${name}」吗？删除后不可恢复。${tail}`
})
// 本学期时长（按天数折算周数，只读展示）
const semesterWeeks = computed(() => {
  if (!semesterStart.value || !semesterEnd.value) return 0
  const days = Math.round((new Date(semesterEnd.value) - new Date(semesterStart.value)) / 86400000) + 1
  return days > 0 ? Math.round(days / 7) : 0
})
// 学期起止日期的合法性：结束不能早于开始。
// 存反了不是显示问题 —— 值日/座位的快照补存拿 semesterRange() 当范围上界，
// 上界小于下界时那边会直接判「学期范围外」整段跳过，用户看到的是「历史记录一直是空的」。
// 两端都留空是允许的（表示不限），只有一端有值也不校验。
const semesterDateError = computed(() => {
  const s = semesterStart.value
  const e = semesterEnd.value
  if (!s || !e) return ''
  if (e < s) return '结束日期不能早于开始日期'
  return ''
})
// 有没有改动过日期（决定「保存」按钮是否可点）
const semesterDatesDirty = computed(() => {
  const cur = activeSemester.value
  if (!cur) return false
  return (cur.start_date || '') !== semesterStart.value || (cur.end_date || '') !== semesterEnd.value
})
// 预览图走 resourceUrl：补完整后端地址并追加 ?token=，保证打包版 file:// 下能通过鉴权
const bgImagePreviewUrl = computed(() => {
  return bgImageUrl.value ? resourceUrl(bgImageUrl.value) : ''
})
const hasUndoRecords = computed(() => {
  return undoGroups.value.length > 0
})
const _undoKeyLabels = computed(() => {
  return { students: '学生表', fee_records: '收费记录', leave_records: '请假记录', score_records: '成绩记录', group_manage: '分组管理', album: '班级相册' }
})
// 性能面板：全局存活状态——三个目标全部存活才算「正常」，否则「部分未启动」
const perfAllAlive = computed(() => {
  const a = perfAlive.value
  return !!(a.front && a.backend && a.widget)
})
// 性能面板：逐进程内存行，按占用从高到低排序
// 占用优先取 privWsKB（专用工作集，与任务管理器「进程」页口径一致）；
// 取不到（非 Windows / 计数器不可用）时回退到 privateKB（私有提交量）
const perfRows = computed(() => {
  const rows = perfProcs.value.map(p => ({
    key: p.key,
    name: p.name,
    memKB: typeof p.privWsKB === 'number'
      ? p.privWsKB
      : (typeof p.privateKB === 'number' ? p.privateKB : null),
  }))
  rows.sort((a, b) => (b.memKB || 0) - (a.memKB || 0))
  return rows
})
// 条形相对比例的分母：让占用最高的进程对应 perfTopRatio（85%~95%）而非满格，
// 其余进程按同比例缩放；分母取 top/ratio 保证首位不恒定 100%
const perfMaxKB = computed(() => {
  const top = perfRows.value[0]
  const topKB = Math.max(1, (top && top.memKB) || 0)
  return topKB / (perfTopRatio.value || 0.9)
})
// 空间管理：彩条分段。颜色是固定的图表色板，不走主题变量 ——
// 四套主题里 --color-primary / --color-info 有重合（base-accent 下两者同值），
// 用主题色会出现「软件本体」和「其他账号」同色的情况，图例就失去意义。
const DISK_CATEGORIES = [
  { key: 'app', label: '软件本体', color: '#5b8def' },
  { key: 'currentAccount', label: '该账号数据', color: '#22c55e' },
  { key: 'otherAccounts', label: '其他账号数据', color: '#f59e0b' },
  { key: 'uploads', label: '上传文件（各账号共享）', color: '#14b8a6' },
  { key: 'thumbs', label: '图片微缩图', color: '#a855f7' },
  { key: 'logs', label: '日志', color: '#64748b' },
  { key: 'other', label: '其他', color: '#94a3b8' },
]
// 空间管理：当前选中的分类（null = 未选中），点彩条或图例走同一入口，再点一次取消
const selectedDiskKey = ref(null)
// 悬浮详情：{ x, y, seg }，鼠标在彩条/图例上移动时更新，移出即清空
const diskTip = ref(null)
// 点别处退出后先抑制浮窗，直到鼠标离开彩条/图例再恢复，免得鼠标没动就立刻弹回来
const diskTipSuppressed = ref(false)
// 百分比按各段合计（= 磁盘上属于本软件的全部体积）算，图例里的占比加起来是 100%
const diskSegments = computed(() => {
  const u = diskUsage.value
  if (!u) return []
  const total = Number(u.total) || 0
  return DISK_CATEGORIES.map((c) => {
    const bytes = Number(u[c.key]) || 0
    const pct = total > 0 ? (bytes / total) * 100 : 0
    return {
      ...c,
      bytes,
      pct,
      pctText: pct >= 9.95 ? `${Math.round(pct)}%` : (pct > 0 ? `${pct.toFixed(1)}%` : '0%'),
    }
  }).filter((s) => s.bytes > 0)
})
// 选中详情以 diskSegments 为唯一真源：重新统计后该分类消失就自动回到未选中态
const selectedDiskSegment = computed(() =>
  selectedDiskKey.value ? diskSegments.value.find((s) => s.key === selectedDiskKey.value) || null : null,
)

// ===== ctx 袋：三个逻辑模块经它互调 =====
const ctx = {
  // 状态 ref（.value 访问）
  settingsSearch, settingsSearchOpen, searchPopup, searchActiveIndex, settingsSections, settingsItems,
  modalType, newUsername, usernamePassword, oldPassword, newPassword, confirmPassword, pwdError, busyPwd,
  usernameError, busyUsername, exportPassword, exportEncrypt, exportDbPwd, busyExport, exportProgress,
  semesters, semesterId, semesterNameDraft, showRenameSemester, newSemesterName, showAddSemester,
  showDeleteSemester, busySemester, busySemesterDate, semesterStart, semesterEnd, semesterDateErrorText,
  dialog, dialogMounted, dialogCallback, deleteTimer, classCount, classList, currentSlug, currentClassName, switchingClass, classDialogVisible, classInfo, toolboxEnabled, noteSavePath, screenshotSavePath,
  screenshotDir, usbAutoOpen, desktopWidgetEnabled, loaded, _fromMainHandler, dataDir,
  busyDataDir, securityLevel, securityLevelLoading, busySecurityLevel,
  securityDialog, privacyPhrase, undoGroups, busyUndo, selectedThemeId, mergeNotifications,
  bgImageUrl, bgImageFileName, perfProcs, perfTopRatio, perfAlive, perfTotal, perfAvg, perfMax,
  perfFront, perfBackend, perfOther, perfStartupTotal, fastStartup, busyGc, busyRestartBackend, busyRestartWidget,
  busyRestartAll, _perfTimer, diskUsage, diskUsageError, busyDisk, busyPurgeThumbs, busySweepThumbs, busyVacuum, vacuumDialog, busyLogs,
  selectedDiskKey, diskTip, diskTipSuppressed,
  // storeToRefs（也是 ref）
  currentTheme, bgMaskOpacity, glassOpacity, iconStyle, topbarColor, animationsEnabled, pendingMode,
  nightSupported, followSystem,
  // computed（ref）
  user, securityLevelOptions, securityLevelHint, dbEncrypted, hasLoginPassword, securityNeedsCurrent, securityNeedsNew,
  securityDialogMessage, themeOptions, isGlassTheme, settingsSearchResults, semesterOptions, activeSemester,
  deleteSemesterMessage, semesterWeeks, semesterDateError, semesterDatesDirty, bgImagePreviewUrl,
  hasUndoRecords, _undoKeyLabels, perfAllAlive, perfRows, perfMaxKB, diskSegments,
  // store / router（普通对象）
  themeStore, route, router,
  // 模板 ref
  settingsSearchInput, settingsSearchPopup, bgImageInput,
  // 非响应式临时字段
  _flashTimer: null, _flashRaf: null, _focusSig: null, _diskAt: 0,
}

// 迟绑定：三个逻辑模块的方法回填进 ctx（互相调用在运行时经 ctx 解析）
Object.assign(ctx, useSettingsSearch(ctx), useSettingsData(ctx), useSettingsAppearance(ctx))

// 点彩条/图例以外的地方 → 退出悬浮详情与选中预览。监听器随组件作用域自动释放。
const diskDisposables = useDisposables()
diskDisposables.listen(document, 'click', (ev) => ctx.onDiskOutsideClick(ev))

// ===== 模板顶层绑定：由逻辑模块提供、模板用到的方法 =====
const {
  barPct, changeDataDir, changePassword, changeUsername,
  clearBgImage, clearUndo, closeModal, closeSecurityDialog,
  confirmAddSemester, confirmDeleteSemester, confirmLogout, confirmSearchActive, confirmSecurityLevel,
  exportDb, fmtBytes, fmtMem, fmtTs, goToSettingsSection, groupLabel, hideDiskTip, loadDiskUsage, moveSearchActive,
  onAnimationsChange, onBgImageFileChange, onBgMaskOpacityChange, onDesktopWidgetChange,
  onDialogCancel, onDialogConfirm, onFastStartupChange, onFollowSystemChange, onGlassOpacityChange, onIconStyleChange,
  onMergeNotificationsChange, onPrivacyPhraseSaved, onSecurityLevelChange, onSelectMode, onSelectSemester,
  onSettingsSearchBlur, onSettingsSearchFocus, onThemeSelect, onToolboxChange, onTopbarColorChange,
  onUsbAutoOpenChange, openAddSemester, openClassDialog, openDeleteAccount, openDeleteClass, openDir, openModal, openRenameSemester,
  purgeThumbs, sweepThumbs, vacuumDb, cancelVacuumWait, clearLogs,
  recycleAll, redoEntry, requestDeleteSemester, restartAll, restartBackend, restartFrontend,
  restartWidget, renameClassFromSettings, saveClassInfoFromSettings, saveSemesterName, saveSemesterSettings, selectDiskSegment, selectFolder, showDiskTip,
  switchClassFromSettings, createClassFromSettings, undoableCount, undoEntry,
} = ctx

// 「修改密码 → 忘记密码？」：已登录且账号已知，所以不列账号列表，直接拿当前账号的库文件验证。
// 验证通过后设新密码（后端换发常规 token），具体流程在 LocalRecoverDialog 里。
const localRecoverVisible = ref(false)
function openLocalRecover() {
  // 超级隐私库没有主密钥包裹，本机恢复走不通 —— 别开一个注定失败的弹窗，直接说清唯一退路
  if (securityLevel.value === 'privacy') {
    useNotification().warning('超级隐私模式没有本机恢复通道：忘记密码只能用 12 词恢复词在登录页重置。')
    return
  }
  localRecoverVisible.value = true
}
function onLocalRecoverDone() {
  localRecoverVisible.value = false
  closeModal()   // 底下的修改密码弹窗还留着上一次填的旧密码，一起关掉，避免误提交
  useNotification().success('密码已重设，下次登录请使用新密码')
}

// 懒加载弹窗保活：首次打开后保持挂载，关闭只降 visible，保留退出动画
watch(() => dialog.value.visible, (n) => { if (n) dialogMounted.value = true })
// 关键字变化时高亮回到第一条（回车默认跳第一个）
watch(settingsSearch, () => { searchActiveIndex.value = 0 })
// 跨页定位：其他页面（如标题栏全局搜索）跳转到 /settings?focus=... 时定位到目标设置
watch(() => route.query.focus, () => { ctx._applyRouteFocus() })

onMounted(() => {
  selectedThemeId.value = currentTheme.value
  bgImageUrl.value = themeStore.backgroundImage
  mergeNotifications.value = (localStorage.getItem('mergeNotifications') ?? '1') === '1'
  ctx.loadUndo()
  ctx.loadSemesterSettings()
  ctx.loadWidgetSettings()
  ctx.loadUsbAutoOpen()
  ctx.loadDataDirs()
  ctx.loadSecurityLevel()
  // 班级列表：账号信息区的「当前班级」和危险区的删班入口都要用，进页面拉一次。
  // 如果是从切班 / 建班的重建中回来（弹窗原本开着），顺带把班级信息一起拉回来再重开。
  // 顺序与首页一致：先填后显 —— ClassInfoDialog 只在 visible 由 false→true 时初始化
  // 表单，先开再填会得到一个字段全空的表单，数据回来也不会补。
  if (settingsClassDialogOpen.value) {
    Promise.all([ctx.loadClassInfo(), ctx.loadClasses()]).finally(() => { classDialogVisible.value = true })
  } else {
    ctx.loadClasses()
  }
  // 性能面板：先取一次启动耗时，轮询由 _startPerfPolling 负责
  ctx.loadStartup()
  // 空间管理：磁盘占用不进轮询（目录遍历代价大），进页面扫一次，20s 内重复进入复用上次结果
  ctx.loadDiskUsage()
  ctx._startPerfPolling()
  _fromMainHandler.value = window.electron?.on(RECEIVE.FROM_MAIN, (data) => {
    // 浮窗右键「关闭工具箱」会把持久化开关置 false，这里刷新一下开关状态
    if (data && data.type === 'toolbox-close-request') ctx.loadWidgetSettings()
  })
})
// 设置页被 KeepAlive 缓存：切走页面走 deactivated 而非 beforeUnmount，
// 必须在这里停掉轮询，否则离开设置页后仍会每 1.8s 采样一次（常驻开销）。
onActivated(() => {
  ctx._startPerfPolling()
  // 从别的页面切回来时库文件可能已经变大，重扫一次（20s 节流在方法内）
  ctx.loadDiskUsage()
  // KeepAlive 恢复时若恢复词仍在展示，重新开启屏幕捕获保护
  ctx.syncPrivacyPhraseGuard(!!privacyPhrase.value)
  // 首次进入（或被缓存的页被重新激活）时若 URL 带 focus，定位到目标设置
  ctx._applyRouteFocus()
})
onDeactivated(() => {
  ctx._stopPerfPolling()
  // 离开设置页时关闭屏幕捕获保护（恢复词区块已不可见）
  ctx.syncPrivacyPhraseGuard(false)
  // 离开设置页时收起搜索弹窗并解除滚动监听，避免弹窗残留在 body 上
  ctx._removeSearchPopupListeners()
  settingsSearchOpen.value = false
  clearTimeout(ctx._flashTimer)
  cancelAnimationFrame(ctx._flashRaf)
})
onBeforeUnmount(() => {
  ctx.syncPrivacyPhraseGuard(false)
  ctx.clearDeleteTimer()
  ctx._stopPerfPolling()
  ctx._removeSearchPopupListeners()
  clearTimeout(ctx._flashTimer)
  cancelAnimationFrame(ctx._flashRaf)
  if (_fromMainHandler.value) {
    window.electron?.off(RECEIVE.FROM_MAIN, _fromMainHandler.value)
  }
})
</script>

<style scoped>
/* 「当前班级」旁边的「切换」：白色毛玻璃小胶囊。
   配方与 ClassInfoDialog 的 .glass-cancel 同源（半透明白 + 背景模糊），
   保证全应用所有毛玻璃按钮观感一致；字色跟随主题，夜间不会变成白底黑字的硬块。 */
.glass-switch {
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.6;
  white-space: nowrap;
  color: var(--color-text);
  background-color: rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(12px) saturate(1.3);
  /* 只有玻璃自身的内高光，不投外阴影：外投影会让它从账号信息行里"浮起来" */
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.6);
  transition: background-color 0.15s ease;
}
.glass-switch:hover {
  background-color: rgba(255, 255, 255, 0.64);
}

/* 设置项搜索跳转锚点：滚动到标题时留出上边距，避免紧贴内容区顶端 */
[id^="settings-section-"] {
  scroll-margin-top: 1.5rem;
}

/* 搜索弹窗：整体自下而上浮入 */
.settings-search-popup {
  animation: settingsSearchPopupIn 0.18s ease-out both;
}
@keyframes settingsSearchPopupIn {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* 弹窗内每条记录：自下而上浮入，按顺序逐条错开（延迟由行内 animation-delay 控制） */
.settings-search-row {
  animation: settingsSearchRowIn 0.2s ease-out both;
}
@keyframes settingsSearchRowIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* 搜索跳转后：目标毛玻璃块做一次柔和的蓝色荧光呼吸（2 次）。
   关键帧只改颜色的透明度、不改阴影的模糊/扩散尺寸，再配 ease-in-out，
   让荧光均匀地渐显渐隐（呼吸感），避免"撑开/突然亮起"的突变观感。
   动画期的 box-shadow 会盖过主题里 .bg-surface 的常规 box-shadow（CSS 动画优先级高于普通声明），
   故 keyframe 里带上原内高光，避免闪动时卡片失光。 */
.settings-flash {
  animation: settingsGlowFlash 0.8s ease-in-out 3;
}
@keyframes settingsGlowFlash {
  0%, 100% {
    box-shadow:
      0 0 0 3px rgba(37, 99, 235, 0),
      0 0 26px 8px rgba(37, 99, 235, 0),
      inset 0 1px 0 rgba(255, 255, 255, 0.15);
  }
  50% {
    box-shadow:
      0 0 0 3px rgba(37, 99, 235, 0.55),
      0 0 26px 8px rgba(37, 99, 235, 0.45),
      inset 0 1px 0 rgba(255, 255, 255, 0.15);
  }
}

/* ===== 空间管理：加粗圆角彩条 + 入场展开 + 点选反馈 + 跟随鼠标的悬浮详情 =====
   .no-animations（设置页动画总开关）已在全局把时长压到 0.001ms，这里再兜一层系统偏好。 */
.disk-bar {
  border-radius: 999px;
  animation: diskBarReveal 0.62s cubic-bezier(0.22, 0.8, 0.24, 1) both;
}
@keyframes diskBarReveal {
  from { clip-path: inset(0 100% 0 0); }
  to   { clip-path: inset(0 0 0 0); }
}
/* 圆角只由 .disk-bar 的 overflow-hidden 裁一次：分段保持方角，
   紧贴的交界处才是直线；若给每段也加圆角，相接处会削出透镜状空隙。 */
.disk-seg {
  border-radius: 0;
  cursor: pointer;
  transition: opacity 0.22s ease, filter 0.22s ease, flex-basis 0.48s cubic-bezier(0.4, 0, 0.2, 1);
}
.disk-seg:hover { filter: brightness(1.12); }
.disk-seg-dim { opacity: 0.38; }
.disk-seg-active {
  filter: brightness(1.08);
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.9), inset 0 0 0 3px rgba(0, 0, 0, 0.18);
}
/* 悬浮只做淡入；位置由 left/top 直接跟鼠标，不加过渡免得拖影 */
.disk-tip {
  animation: diskTipIn 0.14s ease-out both;
}
@keyframes diskTipIn {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .disk-bar, .disk-tip { animation: none; }
  .disk-seg { transition: none; }
}
</style>
