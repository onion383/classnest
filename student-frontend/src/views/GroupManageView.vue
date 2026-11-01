<template>
  <div class="h-full flex flex-col">
    <!-- 顶部标题栏（与其他页面统一） -->
    <div class="w-full bg-surface shadow-md rounded-xl mb-6 px-5 py-3 border border-border min-h-[4.5rem] flex items-center">
      <h1 class="text-2xl font-bold text-text flex items-center gap-2"><IconGlyph name="group" /> 分组管理</h1>
    </div>

    <!-- 维度 tab 切换（用 Tabs 组件） + 添加组 -->
    <Tabs :tabs="dimTabs" :model-value="activeDimId || ''" @update:model-value="onTab">
      <template #extra>
        <button @click="openAddDim" class="px-4 py-2 text-sm rounded-xl bg-primary text-text-inverse transition-theme hover:bg-primary-hover">+ 添加组</button>
      </template>
    </Tabs>

    <!-- 小组管理标题 + 操作按钮行（预留固定高度，避免 v-if 按钮加载后填充/换行引起下方位移/CLS） -->
    <h2 class="text-xl font-semibold text-text mb-4 flex items-center gap-2 min-h-7"><IconGlyph name="box" :size="20" /> 小组管理</h2>
    <div class="opbar flex flex-nowrap items-center gap-3 mb-4 overflow-x-auto">
      <button v-if="activeDim" @click="openSettings" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme flex items-center gap-1.5" title="当前维度设置"><IconGlyph name="settings" :size="14" tint="current" /> 设置</button>
      <button @mouseenter="prefetch(loadSmartGroupDialog)" @click="onSmartGroup" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme">🧠 智能分组</button>
      <button @click="loadAll" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh transition-theme">
        <IconGlyph name="refresh" :size="14" tint="current" /> 刷新
      </button>
      <button @mouseenter="prefetch(loadExportExcel)" @click="openExport" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 transition-theme">
        <IconGlyph name="download" :size="14" tint="current" /> 导出分组
      </button>
    </div>

    <!-- 内容区：不再用玻璃面板包裹（面板内放 EmptySnapshot 会面板套面板、两层毛玻璃），
         与值日页同构：卡片/空态自带 bg-surface，直接放在页面底色上即为单层玻璃。
         仅保留 flex-1 min-h-0 撑满剩余高度、内部滚动这些布局职责。 -->
    <div class="flex-1 min-h-0 flex flex-col">

    <!-- 空状态：占满 flex-1 区域，与有数据网格同高，避免 空态↔数据 切换引起 CLS -->
    <div v-if="dimensions.length === 0" class="flex-1 flex flex-col items-center justify-center text-center text-text-muted">
      <p class="text-lg mb-2">还没有任何分组维度</p>
      <p class="text-sm">点击上方「添加组」创建一个分组维度（如：宿舍管理、学习小组）。</p>
    </div>

    <!-- 内置宿舍维度：一个宿舍都没有时的面板级空态。
         内置宿舍组**没有「＋ 添加小组」入口**（那个卡片只存在于普通维度分支），
         宿舍数只能在「分组设置」里改（男生/女生宿舍数），所以引导按钮直接指过去，
         否则用户对着空面板没有任何出路。
         flex-1 让空态与有数据的网格占同高，切换时不跳。 -->
    <EmptySnapshot
      v-else-if="active && active.dimension.is_default && !(active.groups || []).length"
      class="flex-1"
      icon="🏠"
      text="还没有宿舍分组"
      min-height="220px"
      action-text="去设置"
      action-icon="settings"
      @action="openSettings"
    />

    <!-- 分组卡片网格（仅内置宿舍维度：男女分区列）。
         这里必须带 is_default 判断：下面的「普通维度空态」与「普通维度网格」
         是同级 v-else-if / v-else，若本分支写成 v-else-if="active" 会把它们全部截断成死代码。
         玻璃外观挂在本分支自身（bg-surface 面板），空态分支不带玻璃、直接在页面底色上，
         这样有数据时有面板包着、空态时是单层玻璃卡片，两层玻璃只出现一次。 -->
    <div v-else-if="active && active.dimension.is_default" class="bg-surface shadow-md rounded-xl border border-border px-6 py-5 flex-1 min-h-0 overflow-auto pr-1">
      <div v-if="active.dimension.is_default" class="grid grid-cols-2 gap-x-8 gap-y-5 w-full">
      <!-- 男生/女生两个分区列 -->
      <div v-for="sec in genderSections" :key="sec.title" class="flex flex-col min-w-0">
        <h4 class="text-sm font-semibold text-text mb-3">{{ sec.title }}</h4>
        <!-- 单个性别分区没有宿舍：同样是空态，但不给按钮 ——
             面板级空态负责指路（去设置），这里只作分区内的说明，
             否则两个分区各挂一个「去设置」会显得啰嗦。
             空分组只能靠「设置」里的男/女生宿舍数产生，内置宿舍组没有「＋ 添加小组」入口。 -->
        <EmptySnapshot
          v-if="!sec.groups.length"
          class="flex-1"
          :icon="sec.icon"
          :text="`还没有${sec.title}`"
          min-height="140px"
        />
        <div class="flex flex-col gap-4">
          <!-- 单个宿舍小组小表格卡片 -->
          <div
            v-for="g in sec.groups" :key="g.id"
            :data-row-id="g.id"
            class="bg-surface rounded-xl border border-border overflow-hidden w-full flex flex-col relative"
          >
            <div class="flex items-center justify-between px-3 py-2 bg-primary/5 border-b border-border">
              <input v-model="g.name" @focus="captureGroupOld(g)" @change="renameGroup(g)" class="bg-transparent text-text font-semibold text-sm w-full mr-2 outline-none focus:bg-bg px-1 py-0.5 rounded" />
              <div class="flex items-center gap-1 flex-shrink-0">
                <button @click="addMember(g)" title="添加成员" class="btn-plain grp-btn">＋</button>
                <button @click="confirmDeleteGroup(g)" title="删除小组" class="btn-plain grp-btn grp-btn-del">✕</button>
              </div>
            </div>
            <div :ref="el => setGroupScroll(g.id, el)" class="overflow-x-auto overflow-y-auto max-h-[260px] pr-2.5 app-custom-scroll">
              <table class="w-full text-sm">
                <thead>
                  <tr class="text-text-muted text-sm border-b border-border">
                    <th class="sticky top-0 z-10 grp-th w-6"></th>
                    <th class="sticky top-0 z-10 grp-th text-left font-medium px-3 py-1.5 w-16 whitespace-nowrap">序号</th>
                    <th class="sticky top-0 z-10 grp-th text-left font-medium px-3 py-1.5">成员</th>
                    <th class="sticky top-0 z-10 grp-th text-left font-medium px-3 py-1.5">备注</th>
                    <th class="sticky top-0 z-10 grp-th w-7"></th>
                  </tr>
                </thead>
                <tbody :data-gid="g.id">
                  <tr
                    v-for="(m, i) in g.members"
                    :key="m._local ? `_${g.id}_${m._local}` : m.id"
                    :data-mkey="m._local ? 'l_' + m._local : m.id"
                    :data-index="i"
                    :class="'cursor-grab ' + (i === 0 ? 'bg-info/5 border-b border-border' : 'border-b border-border/60 last:border-0')"
                  >
                    <td class="px-1 w-6 text-center text-text-secondary cursor-grab select-none" @mousedown="onMemberHandleDown($event, g, m, i)">⠿</td>
                    <td class="px-3 py-1.5">
                      <span v-if="i === 0" class="text-info font-medium whitespace-nowrap">{{ active.dimension.leader_title || '舍长' }}</span>
                      <span v-else class="text-text-muted tabular-nums">{{ i + 1 }}</span>
                    </td>
                    <td class="px-3 py-1.5">
                      <input v-model="m.member_name" @input="onMemberInput(m, $event)" @focus="captureMemberOld(m)" @keydown="onMemberKeydown(m, $event)" @change="commitMember(m)" @blur="onMemberBlur(m)" :placeholder="i === 0 ? '' : '成员'" :ref="el => setMemberInput(m, el)" :class="'bg-transparent w-full outline-none focus:bg-bg px-1 py-0.5 rounded ' + (i === 0 ? 'text-text font-medium' : 'text-text')" />
                    </td>
                    <td class="px-3 py-1.5">
                      <input v-model="m.remark" @focus="captureMemberOld(m)" @change="commitMember(m)" placeholder="备注" class="bg-transparent text-text-muted w-full outline-none focus:bg-bg px-1 py-0.5 rounded" />
                    </td>
                    <td class="px-1 text-right">
                      <button @click="removeMember(g, m)" title="移除" class="btn-plain grp-btn-sm grp-btn-del">✕</button>
                    </td>
                  </tr>
                  <tr v-if="g.members.length === 0">
                    <td colspan="5" class="px-3 py-3 text-center text-text-muted text-xs">暂无成员，点击卡片右上角"＋"添加</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- 成员表：细滑块 + 淡入；卡片 relative，右侧 10px 内边距给轨道让位 -->
            <CustomScrollbar
              v-if="groupScrollEls[g.id]"
              :target="groupScrollEls[g.id]"
              compact
              :arrows="false"
              auto-hide
              :min-thumb="20"
            />
          </div>
        </div>
      </div>
    </div>
    </div><!-- 宿舍网格容器结束：普通维度的空态与网格必须是这里的顶层兄弟，否则会被本容器的 v-else-if 拦截成死代码 -->

    <!-- 普通维度：组数未设置（没有任何小组）时的空态。
         小组由设置里的「组数」批量产生（组数增减自动补充/删除小组）。
         注意网格里那个「＋ 添加小组」虚线按钮也挂在 v-else 网格内，
         0 组时整块网格连同按钮都不渲染，用户看到的是空面板，所以必须先指路「去设置」。
         flex-1 让空态与有数据的网格占同高，切换时不跳。 -->
    <EmptySnapshot
      v-else-if="active && !(active.groups || []).length"
      class="flex-1"
      icon="🗂"
      text="还没有设置组数"
      min-height="220px"
      action-text="去设置"
      action-icon="settings"
      @action="openSettings"
    />

    <!-- 普通维度：单一横排网格 + 添加小组。玻璃外观挂本分支（同宿舍分支的口径）。
         用 auto-fill + minmax 而不是 flex-wrap + 固定 320px：卡片定宽时 880px 的容器只放得下 2 个
         （320×3+16×2=992 溢出），右侧空出一大片；改成自适应后同样宽度能排 3 个，窗口拉宽自动加列。 -->
    <div v-else class="bg-surface shadow-md rounded-xl border border-border px-6 py-5 grid gap-4 content-start overflow-auto flex-1 min-h-0" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));">
      <div
        v-for="g in active.groups" :key="g.id"
        :data-row-id="g.id"
        class="bg-surface rounded-xl border border-border overflow-hidden w-full min-w-0 flex flex-col relative"
      >
        <div class="flex items-center justify-between px-3 py-2 bg-primary/5 border-b border-border">
          <input v-model="g.name" @focus="captureGroupOld(g)" @change="renameGroup(g)" class="bg-transparent text-text font-semibold text-sm w-full mr-2 outline-none focus:bg-bg px-1 py-0.5 rounded" />
          <div class="flex items-center gap-1 flex-shrink-0">
            <button @click="addMember(g)" title="添加成员" class="btn-plain grp-btn">＋</button>
            <button @click="confirmDeleteGroup(g)" title="删除小组" class="btn-plain grp-btn grp-btn-del">✕</button>
          </div>
        </div>
        <div :ref="el => setGroupScroll(g.id, el)" class="overflow-x-auto overflow-y-auto max-h-[260px] pr-2.5 app-custom-scroll">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-text-muted text-sm border-b border-border">
                <th class="sticky top-0 z-10 grp-th w-6"></th>
                <th class="sticky top-0 z-10 grp-th text-left font-medium px-3 py-1.5 w-16 whitespace-nowrap">序号</th>
                <th class="sticky top-0 z-10 grp-th text-left font-medium px-3 py-1.5">成员</th>
                <th class="sticky top-0 z-10 grp-th text-left font-medium px-3 py-1.5">备注</th>
                <th class="sticky top-0 z-10 grp-th w-7"></th>
              </tr>
            </thead>
            <tbody :data-gid="g.id">
              <tr
                v-for="(m, i) in g.members"
                :key="m._local ? `_${g.id}_${m._local}` : m.id"
                :data-mkey="m._local ? 'l_' + m._local : m.id"
                :data-index="i"
                :class="'cursor-grab ' + (i === 0 ? 'bg-info/5 border-b border-border' : 'border-b border-border/60 last:border-0')"
              >
                <td class="px-1 w-6 text-center text-text-secondary cursor-grab select-none" @mousedown="onMemberHandleDown($event, g, m, i)">⠿</td>
                <td class="px-3 py-1.5">
                  <span v-if="i === 0" class="text-info font-medium whitespace-nowrap">{{ active.dimension.leader_title || '舍长' }}</span>
                  <span v-else class="text-text-muted tabular-nums">{{ i + 1 }}</span>
                </td>
                <td class="px-3 py-1.5">
                  <input v-model="m.member_name" @input="onMemberInput(m, $event)" @focus="captureMemberOld(m)" @keydown="onMemberKeydown(m, $event)" @change="commitMember(m)" @blur="onMemberBlur(m)" :placeholder="i === 0 ? '' : '成员'" :ref="el => setMemberInput(m, el)" :class="'bg-transparent w-full outline-none focus:bg-bg px-1 py-0.5 rounded ' + (i === 0 ? 'text-text font-medium' : 'text-text')" />
                </td>
                <td class="px-3 py-1.5">
                  <input v-model="m.remark" @focus="captureMemberOld(m)" @change="commitMember(m)" placeholder="备注" class="bg-transparent text-text-muted w-full outline-none focus:bg-bg px-1 py-0.5 rounded" />
                </td>
                <td class="px-1 text-right">
                  <button @click="removeMember(g, m)" title="移除" class="btn-plain grp-btn-sm grp-btn-del">✕</button>
                </td>
              </tr>
              <tr v-if="g.members.length === 0">
                <td colspan="5" class="px-3 py-3 text-center text-text-muted text-xs">暂无成员，点击卡片右上角"＋"添加</td>
              </tr>
            </tbody>
          </table>
        </div>
        <!-- 成员表：细滑块 + 淡入；卡片 relative，右侧 10px 内边距给轨道让位 -->
        <CustomScrollbar
          v-if="groupScrollEls[g.id]"
          :target="groupScrollEls[g.id]"
          compact
          :arrows="false"
          auto-hide
          :min-thumb="20"
        />
      </div>

      <!-- 添加小组卡片 -->
      <button @click="openAddGroup" class="w-full min-h-[7rem] rounded-xl border-2 border-dashed border-amber-400/60 bg-amber-300/10 text-amber-600 hover:bg-amber-300/20 hover:text-amber-700 hover:border-amber-500 transition-theme grid place-items-center cursor-pointer">
        ＋ 添加小组
      </button>
    </div>
    </div><!-- 内容区结束 -->

    <!-- ============ 添加组（新增分组）弹窗 ============ -->
    <Teleport to="body">
    <Transition name="dialog">
    <div v-if="showAddDim" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10003]" @click.self="showAddDim = false">
      <div class="bg-surface p-6 rounded-xl w-[26rem] shadow-card dialog-card border border-border">
        <h3 class="text-lg font-bold text-text mb-4">添加组</h3>
        <p class="text-xs text-text-muted mb-4">添加新的分组（如：宿舍管理、学习小组）</p>
        <label class="block text-sm text-text-secondary mb-1">组名</label>
        <input v-model="addDimForm.name" placeholder="如：宿舍管理" class="border border-border bg-surface text-text px-3 py-2 rounded w-full mb-4" />
        <label class="block text-sm text-text-secondary mb-1">组名排序</label>
        <AppSelect v-model="addDimForm.name_rule" class="w-full" :options="[{value:'custom',label:'自定义'},{value:'cn',label:'第一组，第二组，第三组…'},{value:'num',label:'第1组，第2组，第3组…'},{value:'prefix_cn',label:'{组名} 第一组，{组名} 第二组，{组名} 第三组'},{value:'prefix_num',label:'{组名} 第1组，{组名} 第2组，{组名} 第3组'}]" />
        <p v-if="addDimForm.name_rule !== 'custom'" class="text-xs text-text-muted mb-4 mt-1">初始化小组时将按此规则自动生成组名</p>
        <div v-else class="mb-4"></div>
        <div class="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label class="block text-sm text-text-secondary mb-1">每组人数</label>
            <input v-model.number="addDimForm.members_per_group" type="number" min="0" max="99" class="border border-border bg-surface text-text px-3 py-2 rounded w-full" />
          </div>
          <div>
            <label class="block text-sm text-text-secondary mb-1">组数</label>
            <input v-model.number="addDimForm.group_count" type="number" min="0" max="50" placeholder="自动初始化小组数" class="border border-border bg-surface text-text px-3 py-2 rounded w-full" />
          </div>
        </div>
        <label class="block text-sm text-text-secondary mb-1">组长称呼</label>
        <input v-model="addDimForm.leader_title" placeholder="如：宿舍长 / 学习组长" class="border border-border bg-surface text-text px-3 py-2 rounded w-full mb-4" />
        <div class="flex justify-end gap-2">
          <button @click="showAddDim = false" class="bg-surface-hover text-text border border-border px-4 py-2 rounded transition-theme cursor-pointer">取消</button>
          <button @click="submitAddDim" class="bg-primary text-text-inverse px-4 py-2 rounded transition-theme cursor-pointer">确定</button>
        </div>
      </div>
    </div>
    </Transition>
    </Teleport>

    <!-- ============ 分组设置弹窗（只对当前分组维度生效） ============ -->
    <Teleport to="body">
    <Transition name="dialog">
    <div v-if="showSettings && activeDim" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10003]" @click.self="showSettings = false">
      <div class="bg-surface p-6 rounded-xl w-[26rem] shadow-card dialog-card border border-border">
        <h3 class="text-lg font-bold text-text mb-4">分组设置</h3>
        <p class="text-xs text-text-muted mb-4" v-if="activeDim.is_default">内置宿舍组设置：组名不可修改，按 男/女生宿舍分组</p>
        <p class="text-xs text-text-muted mb-4" v-else>设置仅对当前分组生效；「组数」增减会自动补充或删除小组。</p>

        <label class="block text-sm text-text-secondary mb-1">组名</label>
        <input v-model="settingsForm.name" :disabled="activeDim.is_default" class="border border-border bg-surface text-text px-3 py-2 rounded w-full mb-4 disabled:opacity-50 disabled:cursor-not-allowed" />

        <!-- 普通维度：组名排序（快速生成/重命名组名） -->
        <template v-if="!activeDim.is_default">
          <label class="block text-sm text-text-secondary mb-1">组名排序</label>
          <AppSelect v-model="settingsForm.name_rule" class="w-full" :options="[{value:'custom',label:'自定义'},{value:'cn',label:'第一组，第二组，第三组…'},{value:'num',label:'第1组，第2组，第3组…'},{value:'prefix_cn',label:'{组名} 第一组，{组名} 第二组，{组名} 第三组'},{value:'prefix_num',label:'{组名} 第1组，{组名} 第2组，{组名} 第3组'}]" />
          <p v-if="settingsForm.name_rule !== 'custom'" class="text-xs text-text-muted mb-4 mt-1">保存后按此规则自动生成/重命名现有小组组名</p>
          <div v-else class="mb-4"></div>
        </template>

        <!-- 内置宿舍组：每组人数 + 男/女生宿舍数 -->
        <template v-if="activeDim.is_default">
          <div class="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label class="block text-sm text-text-secondary mb-1">每组人数</label>
              <input v-model.number="settingsForm.members_per_group" type="number" min="0" max="99" class="border border-border bg-surface text-text px-3 py-2 rounded w-full" />
            </div>
            <div></div>
          </div>
          <div class="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label class="block text-sm text-text-secondary mb-1">男生宿舍数</label>
              <input v-model.number="settingsForm.male_group_count" type="number" min="0" max="50" class="border border-border bg-surface text-text px-3 py-2 rounded w-full" />
            </div>
            <div>
              <label class="block text-sm text-text-secondary mb-1">女生宿舍数</label>
              <input v-model.number="settingsForm.female_group_count" type="number" min="0" max="50" class="border border-border bg-surface text-text px-3 py-2 rounded w-full" />
            </div>
          </div>
        </template>

        <!-- 普通维度：每组人数 + 组数 -->
        <div v-else class="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label class="block text-sm text-text-secondary mb-1">每组人数</label>
            <input v-model.number="settingsForm.members_per_group" type="number" min="0" max="99" class="border border-border bg-surface text-text px-3 py-2 rounded w-full" />
          </div>
          <div>
            <label class="block text-sm text-text-secondary mb-1">组数</label>
            <input v-model.number="settingsForm.group_count" type="number" min="0" max="50" class="border border-border bg-surface text-text px-3 py-2 rounded w-full" />
          </div>
        </div>

        <label class="block text-sm text-text-secondary mb-1">组长称呼</label>
        <input v-model="settingsForm.leader_title" placeholder="如：宿舍长 / 学习组长" class="border border-border bg-surface text-text px-3 py-2 rounded w-full mb-4" />
        <div class="flex items-center justify-between gap-2">
          <button
            @click="confirmDeleteDim"
            :disabled="activeDim.is_default"
            class="bg-danger text-white px-4 py-2 rounded transition-theme cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            :title="activeDim.is_default ? '内置宿舍组不可删除' : ''"
          >删除当前分组</button>
          <div class="flex gap-2">
            <button @click="showSettings = false" class="bg-surface-hover text-text border border-border px-4 py-2 rounded transition-theme cursor-pointer">取消</button>
            <button @click="submitSettings" class="bg-primary text-text-inverse px-4 py-2 rounded transition-theme cursor-pointer">确定</button>
          </div>
        </div>
      </div>
    </div>
    </Transition>
    </Teleport>

    <!-- ============ 添加小组弹窗 ============ -->
    <Teleport to="body">
    <Transition name="dialog">
    <div v-if="showAddGroup" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10003]" @click.self="showAddGroup = false">
      <div class="bg-surface p-6 rounded-xl w-96 shadow-card dialog-card border border-border">
        <h3 class="text-lg font-bold text-text mb-4">添加小组</h3>
        <p class="text-xs text-text-muted mb-4">在「{{ activeDim?.name }}」分组类型下新增一个小组。</p>
        <label class="block text-sm text-text-secondary mb-1">小组名字</label>
        <input v-model="addGroupName" placeholder="如：302" class="border border-border bg-surface text-text px-3 py-2 rounded w-full mb-4" />
        <div class="flex justify-end gap-2">
          <button @click="showAddGroup = false" class="bg-surface-hover text-text border border-border px-4 py-2 rounded transition-theme cursor-pointer">取消</button>
          <button @click="submitAddGroup" class="bg-primary text-text-inverse px-4 py-2 rounded transition-theme cursor-pointer">确定</button>
        </div>
      </div>
    </div>
    </Transition>
    </Teleport>

    <!-- ============ 二次确认弹窗 ============ -->
    <Teleport to="body">
    <Transition name="dialog">
    <div v-if="confirmMsg" class="fixed inset-0 bg-black/50 flex items-center justify-center z-[10004]" @click.self="confirmMsg = null">
      <div class="bg-surface p-6 rounded-xl w-96 shadow-card dialog-card border border-border">
        <h3 class="text-lg font-bold text-text mb-3">确认删除</h3>
        <p class="text-text-secondary mb-4">{{ confirmMsg }}</p>
        <div class="flex justify-end gap-2">
          <button @click="confirmMsg = null" class="bg-surface-hover text-text border border-border px-4 py-2 rounded transition-theme cursor-pointer">取消</button>
          <button @click="doDelete" class="bg-danger text-white px-4 py-2 rounded transition-theme cursor-pointer">删除</button>
        </div>
      </div>
    </div>
    </Transition>
    </Teleport>

    <!-- ============ 组名覆盖确认（复用组件 + 统一动画） ============ -->
    <ConfirmDialog
      v-if="overwriteMounted"
      :visible="overwriteVisible"
      message="检测到部分小组已有自定义组名，是否用当前「组名排序」规则覆盖这些组名？"
      :show-cancel="true"
      @confirm="onOverwriteConfirm"
      @cancel="onOverwriteCancel"
    />

    <!-- ============ 成员姓名自动补全弹层（浮在输入框下方） ============ -->
    <Teleport to="body">
      <div
        v-if="suggestState.visible && suggestedStudents.length > 0"
        class="candidate-popup fixed z-[10002] bg-surface border border-info shadow-lg rounded"
        :style="{ left: suggestState.left + 'px', top: suggestState.top + 'px', width: suggestState.width + 'px', maxHeight: '200px', overflow: 'auto' }"
        @mousedown.stop
      >
        <!-- 名册里没有的姓名不会落到「无匹配」空态：suggestedStudents 会把它变成一条「XXX 临时」候选，
             直接点它或回车即落成临时学生（后端 ensureProvisionalStudent 建档）。 -->
        <div
          v-for="(s, idx) in suggestedStudents"
          :key="s.id"
          :class="['px-3 py-2 text-sm cursor-pointer hover:bg-info/10 flex items-center gap-2', { 'bg-info/20': idx === suggestState.index }]"
          @mousedown.prevent="fillCandidate(s)"
          @mouseenter="suggestState.index = idx"
        >
          <span class="flex-1 min-w-0 truncate">{{ s.姓名 }}</span>
          <!-- 临时学生：与正式学生共用同一个 id，标出来便于直接选中已存在的人 -->
          <span v-if="s.is_provisional" class="shrink-0 text-[10px] leading-4 px-1 rounded bg-warning/15 text-warning">临时</span>
        </div>
      </div>
    </Teleport>

    <!-- ============ 智能分组弹窗（仿座位表流水线） ============ -->
    <SmartGroupDialog
      v-if="smartGroupMounted"
      :visible="showSmartGroup"
      :students="allStudents"
      :groups="active?.groups || []"
      :leader-title="activeDim?.leader_title || '组长'"
      @cancel="showSmartGroup = false"
      @confirm="handleSmartGroupResult"
    />

    <!-- ============ 导出弹窗（复用 ExportExcel，选择导出的小组） ============ -->
    <ExportExcel
      v-if="exportMounted"
      :is-visible="exportVisible"
      :rows="[]"
      :fields="[]"
      :default-filename="(activeDim?.name || '分组') + '-分组表'"
      :group-source="groupExportSource"
      @update:is-visible="exportVisible = $event"
    />
  </div>
</template>

<script setup vapor>
import { prefetch } from '../utils/dialogPrefetch.js'
import { ref, reactive, shallowReactive, computed, onMounted, onActivated, nextTick, watch, defineAsyncComponent } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { applyRowShift, clearShift } from '../composables/tableDragFx.js';
import axios from 'axios';
import Tabs from '../components/base/Tabs.vue';
import CustomScrollbar from '../components/base/CustomScrollbar.vue';
import AppSelect from '../components/base/AppSelect.vue';
import EmptySnapshot from '../components/base/EmptySnapshot.vue';
import { useNotification } from '../composables/useNotification';
import { useUndoShortcut } from '../composables/useUndo.js';
import { applyRouteRowFocus } from '../composables/useRowFocus.js';
import { apiFetch } from '../utils/apiUrl.js';

// 弹窗类组件懒加载：打开时才加载对应 chunk
const ConfirmDialog = defineAsyncComponent(() => import('../components/base/ConfirmDialog.vue'));
const loadSmartGroupDialog = () => import('../components/dialogs/SmartGroupDialog/SmartGroupDialog.vue');
const SmartGroupDialog = defineAsyncComponent(loadSmartGroupDialog);
const loadExportExcel = () => import('../components/import-export/ExportExcel/ExportExcel.vue');
const ExportExcel = defineAsyncComponent(loadExportExcel);

const { success, error, info } = useNotification();

// 每个小组表格的滚动容器（v-for 里动态生成的 ref），供各自的细滚动条作为 target。
// 用 shallowReactive：只让「键值变化」可触发重渲染，不代理 DOM 元素本身。
const groupScrollEls = shallowReactive({});
function setGroupScroll(id, el) {
  if (el) groupScrollEls[id] = el;
  else delete groupScrollEls[id];
}

const api = (path, options = {}) =>
  apiFetch(`/api/group-manage${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  });

// 记录分组管理页的单元格撤销：key 统一为 group_manage（便于 Ctrl+Z 连续撤销跨表操作），
// table 为实际数据表名（group_members / groups / group_dimensions），需在 undo.js ALLOWED_TABLES 内。
function recordGroupUndo(table, rowId, field, old, val) {
  try {
    axios.post('/api/undo', {
      key: 'group_manage',
      type: 'cell_update',
      label: `${field}：「${old == null ? '' : old}」→「${val == null ? '' : val}」`,
      payload: { table, rowId, field, oldValue: old, newValue: val }
    }).catch(() => {});
  } catch { /* 撤销记录失败不影响主流程 */ }
}

// 当前维度全量快照（组+成员），用于结构变更撤销对比
function buildGroupSnapshot() {
  return (active.value?.groups || []).map(g => ({
    id: g.id,
    name: g.name,
    gender: g.gender == null ? null : g.gender,
    sort_order: g.sort_order,
    members: (g.members || []).map((m, i) => ({
      id: m.id, member_name: m.member_name, remark: m.remark, sort_order: i + 1
    }))
  }));
}
// 记录一次分组结构变更（增删小组/成员、成员排序、智能分组、小组数量增减等）
function recordGroupStructure(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || JSON.stringify(before) === JSON.stringify(after)) return;
  const dimId = activeDimId.value != null ? Number(activeDimId.value) : active.value?.dimension?.id;
  if (dimId == null) return;
  try {
    axios.post('/api/undo', {
      key: 'group_manage',
      type: 'group_snapshot',
      label: '分组结构变更',
      payload: { dimId, oldValue: before, newValue: after }
    }).catch(() => {});
  } catch { /* 撤销记录失败不影响主流程 */ }
}
useUndoShortcut('group_manage', {
  onAfterUndo: (label) => {
    if (activeDimId.value != null) selectDim(activeDimId.value);
    success(label ? `已撤销：${label}` : '已撤销');
  },
  onAfterRedo: (label) => {
    if (activeDimId.value != null) selectDim(activeDimId.value);
    success(label ? `已重做：${label}` : '已重做');
  }
});

const loading = ref(false);
const dimensions = ref([]);
const activeDimId = ref(null);
const active = ref(null);

const showAddDim = ref(false);
const addDimForm = reactive({ name: '', leader_title: '', members_per_group: 0, group_count: 0, name_rule: 'custom' });
const showSettings = ref(false);
const settingsForm = reactive({ name: '', leader_title: '', members_per_group: 0, group_count: 0, male_group_count: 0, female_group_count: 0, name_rule: 'custom' });
const showAddGroup = ref(false);
const addGroupName = ref('');

// ============ 组名排序：生成规则 ============
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
function cnNum(n) { return CN_NUM[n - 1] || String(n); }
// rule: custom | cn | num | prefix_cn | prefix_num；prefix 为维度名（{组名}）
function buildGroupNames(rule, prefix, count) {
  if (!rule || rule === 'custom' || !count) return null;
  const withPrefix = rule === 'prefix_cn' || rule === 'prefix_num';
  const chinese = rule === 'cn' || rule === 'prefix_cn';
  const names = [];
  for (let i = 1; i <= count; i++) {
    const body = chinese ? `第${cnNum(i)}组` : `第${i}组`;
    names.push(withPrefix ? `${prefix} ${body}` : body);
  }
  return names;
}
async function applyGroupNames(groups, names) {
  if (!names || !groups) return;
  // 并行批量改名（无变化的跳过），比逐个 await 更高效
  await Promise.all(groups.map((g, i) => {
    if (i >= names.length) return;
    if (String(g.name || '') === names[i]) return;
    return api(`/groups/${g.id}`, { method: 'PUT', body: JSON.stringify({ name: names[i] }) });
  }));
}

// ============ 组名覆盖确认 ============
// overwriteMounted 保活：组件首次打开后保持挂载，关闭只降 overwriteVisible，
// 从而让内部 <Transition> 能播放关闭的缩小淡出动画（懒加载不砍动画）
const overwriteMounted = ref(false);
const overwriteVisible = ref(false);
const overwriteInfo = ref(null);

function onOverwriteConfirm() {
  overwriteVisible.value = false;
  const infoObj = overwriteInfo.value;
  overwriteInfo.value = null;
  if (infoObj) doSaveSettings(infoObj.form, infoObj.names);
}
function onOverwriteCancel() {
  overwriteVisible.value = false;
  overwriteInfo.value = null;
}

// ============ 成员姓名自动补全 ============
const allStudents = ref([]);
async function fetchStudents() {
  try {
    const res = await apiFetch('/api/students');
    const data = await res.json();
    // 只接受数组或 {data:数组}：异常形状（如缓存旧密文解出来的 {d}）不覆盖现有名册
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);
    if (!list) { console.error('[students] 响应形状异常', data); return; }
    allStudents.value = list;
  } catch (e) { /* 学生列表不可用时不阻塞分组功能 */ }
}
const suggestState = reactive({ visible: false, member: null, top: 0, left: 0, width: 0, index: 0, keyword: '' });
let suggestTimer = null;
const MAX_SUGGEST = 50;
const suggestedStudents = computed(() => {
  const raw = (suggestState.keyword || '').trim();
  const list = allStudents.value;
  if (!raw) return list.slice(0, MAX_SUGGEST);
  const kw = raw.toLowerCase();
  const matched = [];
  for (let i = 0; i < list.length && matched.length < MAX_SUGGEST; i++) {
    const s = list[i];
    if (String(s.姓名 || '').toLowerCase().includes(kw)) matched.push(s);
  }
  // 名册里没有这个人：把输入的名字本身变成一条「临时」候选（id 用固定哨兵，不与真实学生冲突）。
  // 这样它就和普通候选一样可点选、可回车选中，落库时后端 ensureProvisionalStudent 会建临时学生 ——
  // 不需要单独提示「无匹配」，也不需要用户再点一下别处。
  if (matched.length === 0) {
    return [{ id: '__provisional__', 姓名: raw, is_provisional: true }];
  }
  return matched;
});
function positionSuggest(el) {
  if (!el) return;
  // 用输入框的真实视口坐标定位（Teleport 到 body 后，fixed 相对视口，二者一致）
  const r = el.getBoundingClientRect();
  const w = Math.max(160, r.width);
  const h = 200;
  let x = r.left;
  let y = r.bottom + 2;
  // 防越界：右侧放不下就左移；下方放不下就翻到输入框上方（与座位表填充一致）
  if (x + w > window.innerWidth) x = Math.max(0, window.innerWidth - w - 8);
  if (y + h > window.innerHeight) y = Math.max(0, r.top - h - 2);
  suggestState.left = x;
  suggestState.top = y;
  suggestState.width = w;
}
function onMemberInput(m, e) {
  const el = e.currentTarget;
  const value = e.target.value || '';
  const wasShown = suggestState.visible;
  suggestState.member = m;
  suggestState.index = 0;
  if (!wasShown) {
    // 首次打开：同步应用关键字，且只定位一次（输入框位置在打字过程中不变，无需每次读布局）
    clearTimeout(suggestTimer);
    suggestState.keyword = value;
    suggestState.visible = true;
    nextTick(() => positionSuggest(el));
  } else {
    // 已打开：关键字防抖，避免每次击键全量过滤学生列表
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => { suggestState.keyword = value; }, 120);
  }
}
// 按键时按输入框里的**当前值**重算候选，别用防抖后的 keyword：
// 打完最后一个字立刻回车时，keyword 可能还停在 120ms 前的旧值，会选中一个不相关的人。
function refreshSuggestKeyword() {
  clearTimeout(suggestTimer);
  suggestState.keyword = suggestState.member ? String(suggestState.member.member_name || '') : '';
  return suggestedStudents.value;
}
function onMemberKeydown(m, e) {
  const list = refreshSuggestKeyword();
  if (e.key === 'Tab' || e.key === 'Enter') {
    if (list.length > 0) {
      e.preventDefault();
      // index 可能因列表变短而越界，夹一次
      fillCandidate(list[Math.min(suggestState.index, list.length - 1)]);
      return;
    }
    // 列表为空 = 输入框里是空名（不含空白），没东西可提交；否则按当前值重算后一定至少有一条。
    const name = String(m.member_name || '').trim();
    if (name) {
      e.preventDefault();
      closeSuggest();
      commitMember(m);
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    if (list.length > 0) { e.preventDefault(); suggestState.index = (suggestState.index + 1) % list.length; }
    return;
  }
  if (e.key === 'ArrowUp') {
    if (list.length > 0) { e.preventDefault(); suggestState.index = (suggestState.index - 1 + list.length) % list.length; }
    return;
  }
  if (e.key === 'Escape') closeSuggest();
}
function fillCandidate(s) {
  const m = suggestState.member;
  if (!m) return;
  m.member_name = s.姓名 || '';
  closeSuggest();
  commitMember(m);
}
function closeSuggest() {
  clearTimeout(suggestTimer);
  suggestState.visible = false;
  suggestState.member = null;
  suggestState.keyword = '';
}

// 失焦即收尾：候选弹层收起，新行直接落库。
// 输入完直接点/切到别的框就走，不用再按一次回车 —— blur 早于/晚于 change 都无妨，commitMember 做了幂等包装。
function onMemberBlur(m) {
  closeSuggest();
  if (m.id == null && String(m.member_name || '').trim()) commitMember(m);
}

// Tabs 组件需要 label/value（value 为字符串）
const dimTabs = computed(() => dimensions.value.map(d => ({ value: String(d.id), label: d.name })));
const activeDim = computed(() => (activeDimId.value == null ? null : dimensions.value.find(d => String(d.id) === activeDimId.value) || null));
// 宿舍（内置）维度：按性别拆分为「男生宿舍 / 女生宿舍」两个分区列
const genderSections = computed(() => {
  const d = active.value;
  if (!d || !d.dimension.is_default) return [];
  return [
    { title: '男生宿舍', icon: '👦', groups: d.groups.filter(g => g.gender === 0) },
    { title: '女生宿舍', icon: '👧', groups: d.groups.filter(g => g.gender === 1) },
  ];
});

// 维度详情请求序号：快速连点 tab、或「刷新」与「切 tab」同时发生时，
// 先发出的旧请求可能后到并把新维度的表格覆盖回旧维度（B06-02）。
// selectDim 与 loadAll 的详情刷新共用同一个序号。
let dimDetailSeq = 0;

async function loadAll() {
  if (loading.value) return;
  loading.value = true;
  try {
    // 已有选中维度：只刷新当前展示的表格，不跳转到第一个 tab
    if (activeDimId.value != null) {
      const my = ++dimDetailSeq;
      const data = await api(`/${activeDimId.value}`);
      if (my !== dimDetailSeq) return;
      dimensions.value = data.dimensions || [];
      const dim = data.dimension;
      if (dim) {
        active.value = { dimension: dim, groups: data.groups };
        info(`已刷新「${dim.name}」分组数据`);
      }
      return;
    }
    const data = await api('/bootstrap');
    dimensions.value = data.dimensions || [];
    if (data.active) {
      active.value = data.active;
      activeDimId.value = String(data.active.dimension.id);
    } else {
      active.value = null;
    }
  } catch (e) {
    error(e.message);
  } finally {
    loading.value = false;
  }
}

// 保持选中并刷新维度列表与详情
async function selectDim(id) {
  const my = ++dimDetailSeq;
  activeDimId.value = String(id);
  try {
    const data = await api(`/${id}`);
    // 期间用户又切了维度（或触发了刷新）：这次响应已经过期，丢弃
    if (my !== dimDetailSeq) return;
    dimensions.value = data.dimensions || [];
    active.value = { dimension: data.dimension, groups: data.groups };
  } catch (e) {
    if (my !== dimDetailSeq) return;
    error(e.message);
  }
}

function onTab(value) {
  selectDim(value);
}

// ============ 维度 ============
function openAddDim() {
  Object.assign(addDimForm, { name: '', leader_title: '', members_per_group: 0, group_count: 0, name_rule: 'custom' });
  showAddDim.value = true;
}

async function applyAddDimNames(dimId) {
  if (addDimForm.name_rule === 'custom' || !addDimForm.group_count) return;
  const groups = active.value?.groups || [];
  const names = buildGroupNames(addDimForm.name_rule, addDimForm.name, groups.length);
  if (!names) return;
  await applyGroupNames(groups, names);
  await selectDim(dimId);
}

async function submitAddDim() {
  if (!addDimForm.name.trim()) return error('请输入组名');
  addDimForm.members_per_group = Math.min(99, Math.max(0, Number(addDimForm.members_per_group) || 0));
  addDimForm.group_count = Math.min(50, Math.max(0, Number(addDimForm.group_count) || 0));
  try {
    const data = await api('/dimensions', {
      method: 'POST',
      body: JSON.stringify(addDimForm),
    });
    showAddDim.value = false;
    success('添加成功');
    await selectDim(data.id);
    await applyAddDimNames(data.id);
  } catch (e) {
    error(e.message);
  }
}

function openSettings() {
  if (!activeDim.value) return;
  Object.assign(settingsForm, {
    name: activeDim.value.name,
    leader_title: activeDim.value.leader_title,
    members_per_group: activeDim.value.members_per_group,
    group_count: activeDim.value.group_count,
    male_group_count: activeDim.value.male_group_count || 3,
    female_group_count: activeDim.value.female_group_count || 3,
    name_rule: 'custom',
  });
  showSettings.value = true;
}

// 保存维度设置；names 非空时在保存后按规则重命名小组
async function doSaveSettings(form, names) {
  const before = buildGroupSnapshot();
  try {
    // 维度纯字段编辑（组名 / 组长称呼）的旧值：PUT 成功后才登记撤销，
    // 否则保存失败会留下一条「撤销一个并未生效的修改」的记录（B06-04）
    const dim = active.value?.dimension;
    const oldName = dim ? dim.name : null;
    const oldLeaderTitle = dim ? dim.leader_title : null;
    await api(`/dimensions/${activeDimId.value}`, {
      method: 'PUT',
      body: JSON.stringify(form),
    });
    if (dim) {
      if (String(oldName ?? '') !== String(form.name ?? '')) recordGroupUndo('group_dimensions', dim.id, 'name', oldName ?? '', form.name ?? '');
      if (String(oldLeaderTitle ?? '') !== String(form.leader_title ?? '')) recordGroupUndo('group_dimensions', dim.id, 'leader_title', oldLeaderTitle ?? '', form.leader_title ?? '');
    }
    if (names?.length) await applyGroupNames(active.value?.groups || [], names);
    showSettings.value = false;
    await selectDim(activeDimId.value);
    success('设置已保存');
    recordGroupStructure(before, buildGroupSnapshot());
  } catch (e) {
    error(e.message);
  }
}

async function submitSettings() {
  if (!activeDim.value) return;
  // 内置宿舍组：组名不可改，仅提交每组人数/男女宿舍数/组长称呼
  if (activeDim.value.is_default) {
    settingsForm.members_per_group = Math.min(99, Math.max(0, Number(settingsForm.members_per_group) || 0));
    settingsForm.male_group_count = Math.min(50, Math.max(0, Number(settingsForm.male_group_count) || 0));
    settingsForm.female_group_count = Math.min(50, Math.max(0, Number(settingsForm.female_group_count) || 0));
    const before = buildGroupSnapshot();
    try {
      await api(`/dimensions/${activeDimId.value}`, {
        method: 'PUT',
        body: JSON.stringify({
          leader_title: settingsForm.leader_title,
          members_per_group: settingsForm.members_per_group,
          male_group_count: settingsForm.male_group_count,
          female_group_count: settingsForm.female_group_count,
        }),
      });
      showSettings.value = false;
      await selectDim(activeDimId.value);
      success('设置已保存');
      recordGroupStructure(before, buildGroupSnapshot());
    } catch (e) {
      error(e.message);
    }
    return;
  }
  if (!settingsForm.name.trim()) return error('请输入组名');
  settingsForm.members_per_group = Math.min(99, Math.max(0, Number(settingsForm.members_per_group) || 0));
  settingsForm.group_count = Math.min(50, Math.max(0, Number(settingsForm.group_count) || 0));
  const groups = active.value?.groups || [];
  let names = null;
  if (settingsForm.name_rule !== 'custom' && groups.length > 0) {
    names = buildGroupNames(settingsForm.name_rule, settingsForm.name, groups.length);
    // 检测已有自定义组名（非空且与生成名不一致）→ 弹确认框决定是否覆盖
    const hasCustom = groups.some((g, i) => String(g.name || '').trim() !== '' && g.name !== names[i]);
    if (hasCustom) {
      overwriteInfo.value = { form: JSON.parse(JSON.stringify(settingsForm)), names };
      overwriteMounted.value = true;
      overwriteVisible.value = true;
      return;
    }
  }
  await doSaveSettings(settingsForm, names);
}

// 删除当前维度（入口在设置弹窗；内置宿舍组不可删除）
function confirmDeleteDim() {
  const d = activeDim.value;
  if (!d) return;
  if (d.is_default) return error('内置宿舍组不可删除');
  pendingDelete.value = { type: 'dimension', id: d.id };
  confirmMsg.value = `确定删除维度「${d.name}」吗？其下所有小组与成员将一并删除。`;
}

// ============ 小组 ============
function openAddGroup() {
  addGroupName.value = '';
  showAddGroup.value = true;
}

async function submitAddGroup() {
  if (!addGroupName.value.trim()) return error('请输入小组名字');
  const before = buildGroupSnapshot();
  try {
    await api(`/dimensions/${activeDimId.value}/groups`, {
      method: 'POST',
      body: JSON.stringify({ name: addGroupName.value }),
    });
    showAddGroup.value = false;
    success('添加成功');
    await selectDim(activeDimId.value);
    recordGroupStructure(before, buildGroupSnapshot());
  } catch (e) {
    error(e.message);
  }
}

async function renameGroup(g) {
  if (!g.name.trim()) return error('小组名字不能为空');
  const oldName = g._undoName !== undefined ? g._undoName : g.name;
  const newName = g.name;
  if (String(oldName ?? '') === String(newName ?? '')) { g._undoName = undefined; return; }
  try {
    await api(`/groups/${g.id}`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    // 落库成功后再登记撤销；失败时不留无效撤销记录，并把界面恢复成旧名字（B06-04）
    recordGroupUndo('groups', g.id, 'name', oldName ?? '', newName);
    g._undoName = undefined;
  } catch (e) {
    g.name = oldName;
    error(e.message);
  }
}

function confirmDeleteGroup(g) {
  pendingDelete.value = { type: 'group', id: g.id };
  confirmMsg.value = `确定删除小组「${g.name}」吗？其成员将一并删除。`;
}

// ============ 成员 ============
// 进入行内编辑：快照当前值，供撤销对比（仅记录一次，避免连续 @input 覆盖）
function captureMemberOld(m) {
  if (m._undoName === undefined) m._undoName = m.member_name;
  if (m._undoRemark === undefined) m._undoRemark = m.remark;
}
function captureGroupOld(g) {
  if (g._undoName === undefined) g._undoName = g.name;
}

// ============ 成员行增删动画 ============
// 表格行做不了高度过渡（tr 的高度由内容撑，改 height 收不到 0），所以换一种：
// 记录增删前每行的位置（按 data-mkey），变化后让**其余行平滑滑到新位置**，新行淡入。
// 这样删除一行时下面的行是「升上来」而不是「瞬间跳上来」。
const MEMBER_EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

function captureMemberRows() {
  const map = new Map()
  for (const tr of document.querySelectorAll('tr[data-mkey]')) {
    map.set(tr.dataset.mkey, Math.round(tr.getBoundingClientRect().top))
  }
  return map
}

function playMemberFlip(prev) {
  if (!prev) return
  for (const tr of document.querySelectorAll('tr[data-mkey]')) {
    const oldTop = prev.get(tr.dataset.mkey)
    // 新增的行：淡入 + 轻微下滑
    if (oldTop == null) {
      tr.style.opacity = '0'
      tr.style.transform = 'translateY(-6px)'
      void tr.offsetHeight
      tr.style.transition = `opacity 180ms ease, transform 180ms ${MEMBER_EASE}`
      tr.style.opacity = '1'
      tr.style.transform = ''
      setTimeout(() => { tr.style.transition = ''; tr.style.opacity = ''; tr.style.transform = '' }, 240)
      continue
    }
    const dy = oldTop - Math.round(tr.getBoundingClientRect().top)
    if (!dy) continue
    tr.style.transition = 'none'
    tr.style.transform = `translateY(${dy}px)`
    void tr.offsetHeight // 提交起点，否则「设/清 transform」会被合并成一次，动画不播
    tr.style.transition = `transform 180ms ${MEMBER_EASE}`
    tr.style.transform = ''
    setTimeout(() => { tr.style.transition = ''; tr.style.transform = '' }, 240)
  }
}

function addMember(g) {
  const limit = activeDim.value && activeDim.value.members_per_group;
  if (limit > 0 && g.members.length >= limit) {
    info(`该组人数已达上限 ${limit} 人，无法继续添加`);
    return;
  }
  const m = { _local: Date.now() + Math.random(), _groupId: g.id, member_name: '', remark: '' };
  const prev = captureMemberRows();
  g.members.push(m);
  lastAdded.value = m;
  nextTick(() => {
    playMemberFlip(prev);
    focusMemberInput(m);
  });
}

// 新增成员后把焦点落到这一行的姓名框（点「＋」即可直接打字）。
// 不依赖 memberInputs 这个函数 ref 登记的 Map：那是副产物，某次渲染没赶上就会静默取空，
// 表现为「点了＋没反应」。这里按行标识直接查 DOM —— 和 FLIP 用的是同一个 data-mkey。
function focusMemberInput(m) {
  const key = m._local ? `l_${m._local}` : m.id;
  const tr = document.querySelector(`tr[data-mkey="${key}"]`);
  const el = (tr && tr.querySelector('input')) || memberInputs.get(m) || null;
  if (!el) return;
  // preventScroll：表格限高 260px 会自己滚，交给下面统一处理，
  // 否则浏览器可能先把外层页面/卡片也滚一下，看起来像页面在跳。
  el.focus({ preventScroll: true });
  // 校正目标是整行而不是输入框：只保证输入框可见时，行底边框会被裁掉一截，看起来像切了一半
  const row = tr || el;
  row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // scrollIntoView 的 nearest 会残留几像素（表格行高 + 容器 border 的换算差），新行底边仍被裁一条。
  // 且新增行的插入会让容器 scrollHeight 在之后才定型，此刻测到的可滚上限偏小 —— 所以同步补一次，
  // 下一帧再补一次（那时布局已稳定，才有正确的 scrollHeight）。第二次通常无操作，幂等。
  nudgeIntoView(row);
  requestAnimationFrame(() => { if (row.isConnected) nudgeIntoView(row); });
}

// 按最近的可滚祖先把元素完整推入视区
function nudgeIntoView(el) {
  const scroller = findScrollParent(el);
  if (!scroller) return;
  const er = el.getBoundingClientRect();
  const sr = scroller.getBoundingClientRect();
  if (er.bottom > sr.bottom) scroller.scrollTop += er.bottom - sr.bottom;
  else if (er.top < sr.top) scroller.scrollTop -= sr.top - er.top;
}

// 就近找第一个「确实能滚」的祖先（表格的 overflow-y-auto 容器）
function findScrollParent(el) {
  let p = el.parentElement;
  while (p && p !== document.body) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight - p.clientHeight > 1) return p;
    p = p.parentElement;
  }
  return null;
}

// ============ 成员拖拽排序 / 跨组移动 ============
const memberInputs = new Map();
const lastAdded = ref(null);
// 非响应式：dragover 高频写入，若为响应式会触发整块分组卡片重渲染，故用普通对象
const dragState = { fromMemberId: null, fromGid: null, overGid: null, overIndex: null, pos: 'at' };
// 拖拽落点高亮：命令式增删 class，避免 dropRowClass 进入模板响应式依赖
let _hlRow = null;
let _hlPos = '';
function setDropHighlight(row, pos) {
  if (row === _hlRow && (row ? pos : '') === _hlPos) return;
  if (_hlRow) _hlRow.classList.remove('drop-line', 'drop-before', 'drop-after', 'drop-at');
  _hlRow = row || null;
  _hlPos = row ? pos : '';
  if (_hlRow) {
    _hlRow.classList.add('drop-line');
    _hlRow.classList.add(pos === 'before' ? 'drop-before' : (pos === 'after' ? 'drop-after' : 'drop-at'));
  }
}

function setMemberInput(m, el) {
  if (el) memberInputs.set(m, el);
  else memberInputs.delete(m);
}

// ============ 成员指针拖拽（对标 GridView 的行拖拽） ============
// 不用原生 HTML5 拖拽：drag 会话期间 Chromium 不推进 CSS transition，中间行只能瞬间跳过去；
// 默认拖动快照也只有被拖的那个元素，做不出整行虚影。这里改成 mousedown + rAF 节流：
// 跟手虚影（克隆整行）+ 同组内相邻行实时让位 + 落点高亮线（沿用原来的 setDropHighlight）。
let _memDrag = null;

function findGroupById(gid) {
  // 注意：dataset 读出来一定是字符串，而 g.id 可能是数字，这里统一按字符串比
  return (active.value?.groups || []).find((x) => String(x.id) === String(gid)) || null;
}

// 跟手虚影：把这一行克隆进独立 table，宽度按原件实测固定，否则表格重算列宽会变形
function createMemberGhost(tr, rect) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;left:0;top:0;z-index:100000;pointer-events:none;opacity:.92;'
    + 'will-change:transform;contain:layout paint;box-shadow:0 8px 22px rgba(0,0,0,0.18);border-radius:8px;overflow:hidden;';
  const t = document.createElement('table');
  t.style.cssText = 'border-collapse:collapse;table-layout:fixed;background:var(--color-surface);'
    + 'width:' + rect.width + 'px;';
  const tb = document.createElement('tbody');
  const clone = tr.cloneNode(true);
  clone.classList.remove('mem-dragging');
  clone.style.transition = 'none';
  tb.appendChild(clone);
  t.appendChild(tb);
  wrap.appendChild(t);
  document.body.appendChild(wrap);
  return wrap;
}

function clearRowShift() {
  if (!_memDrag) return;
  if (_memDrag.list) clearShift(_memDrag.list);
  // 复位：让位被清掉后，下一次进入同组必须重新算一遍，否则 draggedTo 还是旧值会跳过
  _memDrag.draggedTo = -1;
}

function onMemberHandleDown(e, g, m, index) {
  if (e.button !== 0) return;
  const tr = e.currentTarget && e.currentTarget.closest ? e.currentTarget.closest('tr') : null;
  if (!tr) return;
  e.preventDefault();
  clearDrag();
  if (_memDrag) return;
  const rect = tr.getBoundingClientRect();
  const tb = tr.parentElement;
  const rows = Array.from(tb.querySelectorAll('tr[data-mkey]'));
  const geom = rows.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; });
  // 成员表是 max-h-[260px] 可滚的：滚动后所有行的视口坐标整体位移。
  // 落点判定现在完全依赖 geom，所以滚动时必须把这个缓存同步平移（绝不重新测量 —— 那时行带着让位位移，
  // 量到的是视觉位置，会把基准污染成错的值）。
  const scroller = tb.parentElement ? tb.parentElement.parentElement : null;
  let lastScrollTop = scroller ? scroller.scrollTop : 0;
  const total = geom.reduce((s, r) => s + (r.bottom - r.top), 0);
  _memDrag = {
    fromGid: g.id,
    fromIdx: index,
    fromEl: tr,
    list: tb,
    rows,
    geom,
    avgH: rows.length ? Math.round(total / rows.length) : 0,
    ghost: createMemberGhost(tr, rect),
    grab: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    draggedTo: index,
    rowAt: index, // 当前目标行（缓冲判定的基准），初始为源行
    raf: 0,
    ev: null,
  };
  _memDrag.ghost.style.transform = 'translate(' + rect.left + 'px, ' + rect.top + 'px)';
  tr.classList.add('mem-dragging');
  dragState.fromMemberId = m.id;
  dragState.fromGid = g.id;

  const move = (ev) => {
    if (!_memDrag) return;
    _memDrag.ev = ev;
    if (_memDrag.raf) return;
    _memDrag.raf = requestAnimationFrame(() => { if (_memDrag) { _memDrag.raf = 0; applyMemberMove(); } });
  };
  const up = () => finishMemberDrag();
  _memDrag.move = move;
  _memDrag.up = up;
  window.addEventListener('mousemove', move, { passive: true });
  window.addEventListener('mouseup', up, { passive: true });
  if (scroller) {
    const syncScroll = () => {
      if (!_memDrag || _memDrag.geom !== geom) return;
      const dy = scroller.scrollTop - lastScrollTop;
      if (!dy) return;
      lastScrollTop = scroller.scrollTop;
      for (const gg of geom) if (gg) { gg.top -= dy; gg.bottom -= dy; }
    };
    _memDrag.scroller = scroller;
    _memDrag.onScrollSync = syncScroll;
    scroller.addEventListener('scroll', syncScroll, { passive: true });
  }
}

// 从命中元素反查它属于哪个组的 tbody。
// 只有「直接命中 tbody 内的元素」这一条路是不够的：让位会把某行整体挪走，
// 鼠标所在位置会露出表格空白，elementFromPoint 命中到的是 <table>（甚至 <thead>），
// 而 <table>.closest('tbody') 是 null —— 于是被判成「没落在任何组里」，
// 让位被 clearRowShift 清掉；下一帧行弹回原位又重新命中，隔帧来回闪。
// 所以命中不到 tbody 时，按表格退一步找它的 tbody。
function resolveMemberBody(under) {
  if (!under || !under.closest) return null;
  const direct = under.closest('tbody[data-gid]');
  if (direct) return direct;
  const tbl = under.closest('table');
  return tbl ? tbl.querySelector('tbody[data-gid]') : null;
}

// 鼠标纵坐标 → 目标行索引。做法与 GridView.resolveRowIndexAt 完全一致：
// 落在某行内就是那一行（行内上下移动不切换），只在行与行的缝隙/容器空白处才取最近的一行。
// 之前用的是「上半插到之前 / 下半插到之后」的半行粒度，每行内部多出一条切换边界 ——
// 鼠标在行内轻微晃动就会在两个插入位之间反复翻，那一行于是纠结要不要让位。
// 整行粒度下，落点 = 鼠标所在行，落库 targetIndex 也直接取这个索引（后端 splice 语义一致）。
// 与目标行之间留 5px 缓冲：鼠标要真正离开当前行 5px 以上才换目标行。
// 行与行的交界是一条零宽的线，鼠标贴着它上下晃几个像素时若不缓冲，
// 目标行会一直 2↔3 翻，那一行就跟着让位/复位 —— 这是"纠结"的最后一段。
const ROW_DEAD = 5;
function memberRowAt(y) {
  const gs = _memDrag && _memDrag.geom;
  if (!gs || !gs.length) return null;
  const cur = _memDrag.rowAt;
  let best = null;
  let min = Infinity;
  for (let i = 0; i < gs.length; i++) {
    const g = gs[i];
    if (!g) continue;
    if (y >= g.top && y <= g.bottom) { best = i; break; }
    const d = Math.min(Math.abs(y - g.top), Math.abs(y - g.bottom));
    if (d < min) { min = d; best = i; }
  }
  if (best === null) return null;
  if (cur !== null && cur !== undefined && cur !== best && gs[cur]) {
    const g = gs[cur];
    const away = y < g.top ? g.top - y : (y > g.bottom ? y - g.bottom : 0);
    if (away < ROW_DEAD) return cur;
  }
  return best;
}

// 把落点定到某一侧（末尾 / 开头）：同组时同步让位，跨组只换高亮
function dropAtEdge(listEls, target, cgid, same) {
  const d = _memDrag;
  if (!d || !listEls || !listEls.length || target == null || target < 0) return;
  dragState.overGid = cgid;
  dragState.overIndex = target;
  dragState.pos = 'at';
  setDropHighlight(listEls[target], 'at');
  if (same) {
    if (d.draggedTo !== target) {
      d.draggedTo = target;
      applyRowShift(d.rows, d.fromIdx, target, d.geom, d.avgH);
    }
  } else {
    clearRowShift();
  }
}

function applyMemberMove() {
  const d = _memDrag;
  if (!d || !d.ev) return;
  const ev = d.ev;
  d.ghost.style.transform = 'translate(' + (ev.clientX - d.grab.x) + 'px, ' + (ev.clientY - d.grab.y) + 'px)';
  // 虚影是 pointer-events:none，这里拿到的是它下面的真实元素
  const under = document.elementFromPoint(ev.clientX, ev.clientY);
  const bodyEl = resolveMemberBody(under);
  if (!bodyEl) {
    // 不在任何表格上：可能拖到了组卡片里「表格之外」的地方（标题栏 / 表格下方留白）。
    // 这时按「落到该组的末尾或开头」处理，而不是直接取消落点 ——
    // 取消落点会让 dragState 停在上一次的值，松手常常变成插到最前面，用户看到的就是"让第一行"。
    const cardEl = under && under.closest ? under.closest('[data-row-id]') : null;
    if (cardEl) {
      const cgid = cardEl.dataset.rowId;
      const same = String(cgid) === String(d.fromGid);
      const list = same ? d.rows : Array.from(cardEl.querySelectorAll('tr[data-mkey]'));
      if (list && list.length) {
        const tbl = cardEl.querySelector('table');
        const tb = tbl ? tbl.getBoundingClientRect() : null;
        dropAtEdge(list, !tb || ev.clientY > tb.bottom ? list.length - 1 : 0, cgid, same);
        return;
      }
    }
    // 已拖出卡片、但还在这张表格的正下方（同列空白）：也算「放到本组末尾」
    const srcTbl = d.list && d.list.closest ? d.list.closest('table') : null;
    const sr = srcTbl ? srcTbl.getBoundingClientRect() : null;
    if (sr && d.rows && d.rows.length && ev.clientX >= sr.left && ev.clientX <= sr.right && ev.clientY > sr.bottom) {
      dropAtEdge(d.rows, d.rows.length - 1, d.fromGid, true);
      return;
    }
    clearRowShift(); setDropHighlight(null, 'at'); return;
  }
  const gid = bodyEl.dataset.gid;

  if (String(gid) === String(d.fromGid)) {
    // 同组：只用缓存的布局几何算插入位，**完全不看命中了哪一行**。
    // 让位会把相邻行挪到鼠标底下，命中结果每帧都在换行，
    // 「该不该让位」跟着反复翻转 —— 看到的就是某一行在纠结要不要让位。
    const to = memberRowAt(ev.clientY);
    if (to === null) { clearRowShift(); setDropHighlight(null, 'at'); return; }
    d.rowAt = to;
    dragState.overGid = gid;
    dragState.overIndex = to;
    dragState.pos = 'at';
    setDropHighlight(d.rows[to], 'at');
    if (to !== d.draggedTo) {
      d.draggedTo = to;
      applyRowShift(d.rows, d.fromIdx, to, d.geom, d.avgH);
    }
    return;
  }

  // 以下都是跨组：源组的让位已清空，目标组的行没有 transform，rect 就是布局位置
  const rowEl = under.closest('tr[data-mkey]');
  if (rowEl) {
    dragState.overGid = gid;
    dragState.overIndex = Number(rowEl.dataset.index);
    dragState.pos = 'at';
    setDropHighlight(rowEl, 'at');
    clearRowShift();
    return;
  }
  // 落在目标组的空白处：追加到末尾
  const g = findGroupById(gid);
  if (!g || !g.members.length) { clearRowShift(); setDropHighlight(null, 'after'); return; }
  dragState.overGid = gid;
  dragState.overIndex = g.members.length;
  dragState.pos = 'at';
  setDropHighlight(null, 'at');
  clearRowShift();
}

// 松手后虚影要飞向的位置：目标行的「布局位置」（不含让位位移）。
// 同组用按下时缓存的 geom（已按滚动补偿，不受 transform 影响）；
// 跨组的目标行本来就没有 transform，直接用 rect。
function ghostFlyTarget(d) {
  const idx = dragState.overIndex;
  if (idx == null || idx < 0) return null;
  const same = String(dragState.overGid) === String(d.fromGid);
  let el = same && d.rows ? d.rows[idx] : null;
  if (!el) {
    const body = document.querySelector('tbody[data-gid="' + dragState.overGid + '"]');
    el = body ? body.querySelectorAll('tr[data-mkey]')[idx] : null;
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const g = same && d.geom ? d.geom[idx] : null;
  return { left: Math.round(r.left), top: Math.round(g ? g.top : r.top) };
}

function finishMemberDrag() {
  const d = _memDrag;
  if (!d) return;
  window.removeEventListener('mousemove', d.move);
  window.removeEventListener('mouseup', d.up);
  if (d.scroller && d.onScrollSync) d.scroller.removeEventListener('scroll', d.onScrollSync);
  if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0 }
  // 落点快照：回弹动画期间可能又按下一次拖动，dragState 会被覆盖，提交时要用松手那一刻的值
  const snap = { ...dragState };
  const done = () => {
    Object.assign(dragState, snap);
    if (d.fromEl) d.fromEl.classList.remove('mem-dragging');
    clearShift(d.list);
    setDropHighlight(null, 'at');
    commitMemberMove();
  };

  const target = ghostFlyTarget(d);
  if (!d.ghost || !target) {
    if (d.ghost) d.ghost.remove();
    _memDrag = null;
    done();
    return;
  }

  // 回弹：虚影从松手位置沿 XY 滑到目标行，**不淡出** —— 落点就是最终位置，让它停在那儿。
  // 到位后再提交（重排后源行正好出现在同一位置），最后才移除虚影，
  // 这样中间不会出现「虚影先消失、行后出现」的空档，观感是"放进去就变成真的行"。
  const ghost = d.ghost;
  ghost.style.transition = 'transform 200ms cubic-bezier(0.22, 0.61, 0.36, 1)';
  ghost.style.transform = 'translate(' + target.left + 'px, ' + target.top + 'px)';
  _memDrag = null;
  setTimeout(() => {
    // 先摘掉源行的「被拿起」半透明，否则重排时元素被移动、类还留在上面
    if (d.fromEl) d.fromEl.classList.remove('mem-dragging');
    Promise.resolve(commitMemberMove(snap)).finally(() => {
      ghost.remove();
      clearShift(d.list);
      setDropHighlight(null, 'at');
    });
  }, 200);
}

// 落库：沿用原 onMemberDrop 的判定（上限校验 / before-after 换算），只是触发源换成了 mouseup
function commitMemberMove(override) {
  const src = override || dragState;
  const mid = src.fromMemberId;
  const gid = src.overGid;
  const idx = src.overIndex;
  const pos = src.pos;
  const fromGid = src.fromGid;
  clearDrag();
  if (mid == null || gid == null) return Promise.resolve(false);
  const g = findGroupById(gid);
  if (!g) return Promise.resolve(false);
  const limit = activeDim.value?.members_per_group || 0;
  if (fromGid !== gid && limit > 0 && g.members.length >= limit) {
    info('该组人数已达上限 ' + limit + ' 人，无法移入');
    return Promise.resolve(false);
  }
  // pos==='at'：鼠标落在哪一行，就移到那一行的位置（与后端 splice(idx,0,id) 语义一致）
  const targetIndex = idx == null ? g.members.length : (pos === 'at' ? idx : (pos === 'before' ? idx : idx + 1));
  return moveMember(mid, gid, targetIndex);
}

function clearDrag() {
  dragState.fromMemberId = null;
  dragState.fromGid = null;
  dragState.overGid = null;
  dragState.overIndex = null;
  dragState.pos = 'after';
  setDropHighlight(null, 'after');
}

async function moveMember(memberId, targetGroupId, targetIndex) {
  const before = buildGroupSnapshot();
  try {
    const data = await api('/group-members/move', {
      method: 'POST',
      body: JSON.stringify({ memberId, targetGroupId, targetIndex }),
    });
    dimensions.value = data.dimensions || [];
    if (data.dimension) active.value = { dimension: data.dimension, groups: data.groups };
    recordGroupStructure(before, buildGroupSnapshot());
  } catch (e) {
    error(e.message);
  }
}

// 失焦提交：新成员则创建，已存在成员则更新；空名不落库（删除本地占位行）
// 同一个成员可能被两条路径同时提交（change 与 blur），幂等包一层，避免重复 POST 建出两行
const committingMembers = new WeakSet();
function commitMember(m) {
  if (committingMembers.has(m)) return Promise.resolve();
  committingMembers.add(m);
  return doCommitMember(m).finally(() => committingMembers.delete(m));
}
async function doCommitMember(m) {
  if (m.id == null) {
    if (!m.member_name.trim()) {
      return;
    }
    const before = buildGroupSnapshot();
    try {
      const data = await api(`/groups/${m._groupId}/members`, {
        method: 'POST',
        body: JSON.stringify({ member_name: m.member_name, remark: m.remark }),
      });
      m.id = data.id;
      // 这里不再 selectDim 整表刷新：它会把 groups 整体替换、所有成员行 DOM 重建，
      // 用户刚点进的下一个输入框会立刻失焦 —— 连续录入变成「每输一个都要重新点一次」。
      // 新行就地「转正」即可，数据与后端一致：姓名/备注是本地值，sort_order 后端取 max+1（末尾），
      // 前端 push 也在末尾。_local 保留不动，让 v-for 的 key 稳定、这一行自己也不重建。
      recordGroupStructure(before, buildGroupSnapshot());
      // 新名字可能刚在后端被记为临时学生：刷新候选名册，下一次输入就能带「临时」标记选到它
      fetchStudents();
    } catch (e) {
      error(e.message);
    }
    return;
  }
  const oldName = m._undoName !== undefined ? m._undoName : m.member_name;
  const oldRemark = m._undoRemark !== undefined ? m._undoRemark : m.remark;
  const newName = m.member_name;
  const newRemark = m.remark;
  try {
    await api(`/group-members/${m.id}`, {
      method: 'PUT',
      body: JSON.stringify({ member_name: newName, remark: newRemark }),
    });
    // 保存成功后才登记撤销；失败时回滚界面到旧值，避免「撤销一个没生效的修改」（B06-04）
    if (String(oldName ?? '') !== String(newName ?? '')) recordGroupUndo('group_members', m.id, 'member_name', oldName ?? '', newName);
    if (String(oldRemark ?? '') !== String(newRemark ?? '')) recordGroupUndo('group_members', m.id, 'remark', oldRemark ?? '', newRemark);
    // 改名也可能产生新的临时学生（原名被替换）；刷新候选名册
    if (String(oldName ?? '') !== String(newName ?? '')) fetchStudents();
    m._undoName = undefined;
    m._undoRemark = undefined;
  } catch (e) {
    m.member_name = oldName;
    m.remark = oldRemark;
    error(e.message);
  }
}

function removeMember(g, m) {
  const prev = captureMemberRows();
  if (m.id == null) {
    g.members = g.members.filter(x => x !== m);
    nextTick(() => playMemberFlip(prev));
    return;
  }
  doRemoveMember(g, m.id, prev);
}

async function doRemoveMember(g, id, prevRects) {
  const before = buildGroupSnapshot();
  const prev = prevRects || captureMemberRows();
  try {
    await api(`/group-members/${id}`, { method: 'DELETE' });
    await selectDim(activeDimId.value);
    recordGroupStructure(before, buildGroupSnapshot());
    await nextTick();
    playMemberFlip(prev);
  } catch (e) {
    error(e.message);
  }
}

// ============ 删除确认 ============
const confirmMsg = ref(null);
const pendingDelete = ref(null);

async function doDelete() {
  const p = pendingDelete.value;
  if (!p) return;
  const isGroup = p.type === 'group';
  // 仅小组删除做撤销（维度删除不含在内）；快照需基于删除前的维度结构
  const before = isGroup ? buildGroupSnapshot() : null;
  try {
    if (p.type === 'dimension') await api(`/dimensions/${p.id}`, { method: 'DELETE' });
    else await api(`/groups/${p.id}`, { method: 'DELETE' });
    confirmMsg.value = null;
    pendingDelete.value = null;
    showSettings.value = false;
    success('删除成功');
    await loadAll();
    // 小组删除后再拉一次当前维度，确保快照取自最新结构
    if (isGroup) { await selectDim(activeDimId.value); recordGroupStructure(before, buildGroupSnapshot()); }
  } catch (e) {
    error(e.message);
  }
}

// ============ 智能分组入口 ============
// smartGroupMounted 保活：保持挂载以便关闭动画播放
const smartGroupMounted = ref(false);
const showSmartGroup = ref(false);
function onSmartGroup() {
  if (!activeDim.value) return error('请先选择分组维度');
  if (!active.value?.groups?.length) return error('当前维度还没有小组，请先添加小组');
  smartGroupMounted.value = true;
  showSmartGroup.value = true;
}

// 确认写入：清空该维度所有小组成员，按第 i 组写入 result.groups[i]，组长排最前
async function handleSmartGroupResult(result) {
  const groups = result && result.groups;
  if (!Array.isArray(groups)) return;
  const before = buildGroupSnapshot();
  try {
    const data = await api(`/dimensions/${activeDimId.value}/apply-grouping`, {
      method: 'POST',
      body: JSON.stringify({ groups }),
    });
    showSmartGroup.value = false;
    dimensions.value = data.dimensions || [];
    if (data.dimension) active.value = { dimension: data.dimension, groups: data.groups };
    success('智能分组已应用');
    recordGroupStructure(before, buildGroupSnapshot());
  } catch (e) {
    error(e.message);
  }
}

// ============ 导出（复用 ExportExcel 弹窗，选择导出的小组） ============
// exportMounted 保活：保持挂载以便关闭动画播放
const exportMounted = ref(false);
const exportVisible = ref(false);
// 传给导出弹窗的分组数据结构
const groupExportSource = computed(() => {
  if (!active.value) return null;
  return {
    title: `${active.value.dimension.name}-分组表`,
    leaderTitle: active.value.dimension.leader_title || '组长',
    groups: (active.value.groups || []).map(g => ({
      name: g.name,
      members: (g.members || []).map(m => ({ member_name: m.member_name, remark: m.remark }))
    }))
  };
});
async function openExport() {
  if (!active.value || active.value.groups.length === 0) return useNotification().info('暂无小组可导出');
  exportMounted.value = true;
  exportVisible.value = true;
}

// 跨页定位：标题栏全局搜索点「分组」结果跳转 /group-manage?focus=dim:<dimId>:<groupId>。
// 组可能不在当前维度下：先切到其所属维度（异步加载），加载完成后再滚动并高亮该组卡片。
const route = useRoute()
const router = useRouter()
// 行定位宿主：显式传路由对象（身份稳定供 useRowFocus 记签名；不再经实例代理）
const rowFocusHost = { route, router }
;
let pendingDim = null;
function applyFocus() {
  applyRouteRowFocus(rowFocusHost, {
    parse: (key) => {
      const [tag, dimId, gid] = String(key).split(':');
      if (tag !== 'dim' || !gid) return null;
      if (String(activeDimId.value) !== String(dimId)) {
        if (pendingDim !== String(dimId)) {
          pendingDim = String(dimId);
          selectDim(dimId); // 异步；本次返回 null，等维度加载后再由 helper 重试定位
        }
        return null;
      }
      pendingDim = null;
      return gid;
    }
  });
}

onMounted(async () => { await loadAll(); fetchStudents(); applyFocus(); });
onActivated(applyFocus);
watch(() => route.query.focus, applyFocus);
</script>

<style scoped>
/* 吸顶表头。不能沿用 .bg-surface —— glass 主题给它挂了 20px 圆角（那是给卡片/弹窗用的），
   十个 th 各自套一个就成了十个圆角块。这里只取它的底色 + 磨砂，不带圆角。 */
.mem-dragging {
  opacity: 0.35;
}
.grp-th {
  background: var(--color-surface);
  backdrop-filter: blur(14px) saturate(1.1);
  -webkit-backdrop-filter: blur(14px) saturate(1.1);
}
/* 小组卡片里的图标键：统一用 .btn-plain（无描边圆角方块，见 styles/utilities.css）。
   原来直接写 <button>，会被主题的 button 皮肤套上「描边 + 胶囊圆角」，
   在卡片头 / 表格行里看着像贴上去的异物。 */
.grp-btn {
  width: 24px;
  height: 24px;
  font-size: 14px;
}
.grp-btn-sm {
  width: 20px;
  height: 20px;
  font-size: 12px;
}
/* 删除类按钮 hover 变红（.dlg-close:hover 默认是普通文字色，这里要压过它） */
.grp-btn-del:hover {
  color: var(--color-danger);
}
/* 成员拖拽：虚拟位置反馈线（上/下缘高亮） */
tbody tr[class*="drop-line"] td,
tbody tr.drop-before td,
tbody tr.drop-after td {
  position: relative;
}
tbody tr.drop-before td::before,
tbody tr.drop-after td::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--color-primary, #3b82f6);
  z-index: 1;
}
tbody tr.drop-before td::before { top: -1px; }
tbody tr.drop-after td::before { bottom: -1px; }
/* 落点 = 整行（与 GridView 的行落点框同构）：整行淡底 + 上下描边。
   判定改成「鼠标落在哪一行」之后，原来的上/下缘细线会指错位置，所以换成一整块的提示。 */
tbody tr.drop-at td {
  background: color-mix(in srgb, var(--color-primary, #3b82f6) 12%, transparent);
  box-shadow: inset 0 1px 0 var(--color-primary, #3b82f6), inset 0 -1px 0 var(--color-primary, #3b82f6);
}

/* 拖动中的行轻微半透明，作为手的反馈 */
tbody tr[class*="drop-line"] { transition: background-color .12s ease; }
</style>