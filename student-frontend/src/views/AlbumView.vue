<template>
  <div class="h-full flex flex-col relative">
    <!-- 顶部标题栏：左侧标题，右侧统计（照片 | 相册 | 总占用），样式对齐首页标题栏 -->
    <div class="w-full bg-surface shadow-md rounded-xl mb-6 px-5 py-3 border border-border min-h-[4.5rem] flex items-center">
      <div class="flex-1 flex items-center justify-between gap-3">
        <h1 class="text-2xl font-bold text-text flex items-center gap-2"><IconGlyph name="album" /> 班级相册</h1>
        <div class="flex items-center gap-4 shrink-0">
          <div class="flex items-baseline gap-1.5" title="已索引的照片总数（按文件去重）">
            <span class="text-lg font-bold text-success leading-none tabular-nums">{{ albumStats.photo_count }}</span>
            <span class="text-xs text-text-muted">照片</span>
          </div>
          <div class="w-px h-6 bg-border"></div>
          <div class="flex items-baseline gap-1.5" title="相册数量">
            <span class="text-lg font-bold text-warning leading-none tabular-nums">{{ albumStats.album_count }}</span>
            <span class="text-xs text-text-muted">相册</span>
          </div>
          <div class="w-px h-6 bg-border"></div>
          <div class="flex items-baseline gap-1.5" title="照片与视频的总占用体积">
            <span class="text-lg font-bold text-primary leading-none tabular-nums">{{ sizeParts.value }}</span>
            <span class="text-xs text-text-muted">{{ sizeParts.unit }}</span>
          </div>
        </div>
      </div>
      <p v-if="busyScan" class="text-xs mt-3 px-4 py-2 bg-bg rounded text-text-secondary">正在更新照片索引…（可在「任务管理」中查看进度或停止）</p>
    </div>

    <!-- 工具栏：相册级操作 + 右侧视图切换（时间轴 / 相册），两个视图下都保留 -->
    <!-- flex-wrap：窗口贴到最小宽度（900）时按钮多，宁可换行也不要横向溢出把 ViewSwitch 挤出去 -->
    <div class="album-toolbar flex items-center gap-3 mb-4 flex-shrink-0 flex-wrap">
      <button @mouseenter="prefetch(loadNewAlbumDialog)" @click="openNewAlbum" class="bg-primary hover:bg-primary-hover text-text-inverse px-4 py-2 rounded transition-theme flex items-center gap-1.5">
        <IconGlyph name="folder" :size="14" tint="current" /> 新建相册
      </button>
      <button @mouseenter="prefetch(loadAlbumManageDialog)" @click="openManage" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh transition-theme">
        <IconGlyph name="settings" :size="14" tint="current" /> 管理相册
      </button>
      <button @mouseenter="prefetch(loadAlbumTaskDialog)" @click="openTask" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded transition-theme flex items-center gap-1.5">
        <IconGlyph name="clock" :size="14" tint="current" /> 任务管理
      </button>
      <!-- 多选：时间轴选照片（移动/全选），相册视图选虚拟相册（合并）；再点一次退出 -->
      <button
        @click="toggleSelectMode"
        :disabled="activeTab === 'gallery' ? albums.length === 0 : !activeAlbum"
        class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh disabled:opacity-50 transition-theme"
        title="进入 / 退出多选（时间轴选照片，相册视图选虚拟相册合并）"
      >
        <IconGlyph name="check" :size="14" tint="current" /> 多选
      </button>
      <button @mouseenter="prefetch(loadExportAlbumIndex)" @click="openExport" class="bg-warning hover:bg-warning-hover text-text-inverse px-4 py-2 rounded transition-theme flex items-center gap-1.5">
        <IconGlyph name="download" :size="14" tint="current" /> 导出相册索引
      </button>
      <!-- 刷新：从标题栏移到菜单栏，增量更新当前相册的照片索引 -->
      <button @click="refreshAll" :disabled="busyScan || !activeAlbumId" class="bg-text-muted hover:bg-text-secondary text-text-inverse px-4 py-2 rounded flex items-center gap-1.5 btn-refresh disabled:opacity-50 transition-theme" :title="activeAlbumIsVirtual ? '按已有索引更新拍摄时间与缩略图（不遍历文件夹）' : '增量更新当前相册的照片索引'">
        <IconGlyph name="refresh" :size="14" tint="current" /> {{ busyScan ? '刷新中…' : '刷新' }}
      </button>
      <!-- 视图切换：紧跟「刷新」右侧并右对齐 -->
      <ViewSwitch v-model="activeTab" :options="VIEW_OPTIONS" class="ml-auto" />
    </div>

    <!-- ==================== 时间轴：照片按日期分组的网格 ==================== -->
    <div v-if="activeTab === 'timeline'" class="flex-1 min-h-0 flex flex-col">
      <!-- 相册切换条 -->
      <div v-if="albums.length > 1" class="flex gap-2 mb-4 flex-wrap">
        <button
          v-for="a in albums" :key="a.id"
          :data-row-id="a.id"
          @click="selectAlbum(a.id)"
          class="px-4 py-2 rounded transition-theme text-sm"
          :class="activeAlbumId === a.id ? 'bg-primary text-text-inverse' : 'bg-surface text-text border border-border hover:bg-surface-hover'"
        >
          {{ a.name }}（{{ a.photo_count }}）
        </button>
      </div>

      <!-- 空状态：空态卡片 + 新建相册按钮，占满剩余高度，与有数据时同高，避免切换跳动 -->
      <EmptySnapshot
        v-if="!activeAlbum"
        class="flex-1"
        icon="album"
        text="还没有相册"
        min-height="320px"
        action-text="新建相册"
        action-icon="folder"
        @action="openNewAlbum"
      />

      <!-- 照片按日期分组（网格窗口化虚拟滚动） -->
      <div v-else class="flex-1 min-h-0 flex flex-col">
        <p v-if="groups.length === 0" class="bg-surface rounded-xl border border-border p-12 text-center text-text-muted">
          当前相册暂无照片，点击「刷新」或到设置页「更新文件夹照片」重新扫描。
        </p>

        <!-- 照片区 + 右侧年份刻度尺：外层一层毛玻璃面板，两者同处其中。
             玻璃观感不在这里硬写：`.bg-surface` 是项目统一的玻璃入口 ——
             glass 走 theme-glass.css 的 `main .bg-surface` 配方（底色 + blur(24px) saturate(1.4)），
             glass2 走 theme-glass2.css 的 `.bg-surface` 规则；夜间模式各自覆盖。
             p-5 与其它玻璃卡片同一档（项目里 33 处卡片都用它），且正好等于 glass 主题的卡片圆角半径，
             内边距不小于圆角半径，内容不会被圆弧切掉角。
             overflow-hidden 只为让内部滚动内容被圆角裁掉（不裁的话滚动时直角格子会顶出圆弧）。 -->
        <div v-else class="flex-1 min-h-0 flex gap-1 bg-surface border border-border rounded-xl p-5 overflow-hidden">
          <!-- 虚拟滚动容器：只挂载视口附近的分组，外部用总高度撑起滚动条 -->
          <div ref="containerRef" class="flex-1 overflow-auto min-h-0 album-scroll" @scroll="onScroll">
          <div class="relative" :style="{ height: totalH + 'px' }">
            <div
              v-for="v in renderedGroups"
              :key="v.date"
              class="absolute left-0 right-0 mb-8 album-group"
              :style="{ top: v.offset + 'px' }"
            >
              <h2 class="text-lg font-semibold text-text mb-3 flex items-center gap-2">
                <span class="px-2 py-0.5 bg-info/10 text-info rounded text-sm">{{ v.g.date }}</span>
                <span class="text-xs text-text-muted">{{ groupCountOf(v.g) }} 张</span>
                <!-- 日期来源提示：日期组里混有读不到拍摄时间的照片时给出个数（读不到的那些单独归「未知时间」） -->
                <span
                  v-if="groupDateHint(v.g)"
                  class="text-xs text-text-muted border border-border rounded px-1.5 py-0.5"
                  :title="`${groupDateHint(v.g)}：图片里没有可读的拍摄时间，已单独归到时间轴最底部的「未知时间」`"
                >{{ groupDateHint(v.g) }}</span>
              </h2>
              <div class="relative" :style="{ height: v.contentH + 'px' }">
                <!-- 分页加载中：高度已按 count 预留好，这里只占位提示，不等同于「这个日期没有照片」 -->
                <div v-if="!v.loaded" class="text-sm text-text-muted py-2">加载中…</div>
                <!-- 组内按行裁剪：每行一个绝对定位容器，行位置由「列数 × 格宽」直接算出来。
                     原来这里是 flex-wrap + 整组 v-for，一天几千张就会有几千个格子常驻 DOM。 -->
                <div
                  v-for="row in v.rows"
                  :key="row.n"
                  class="absolute left-0 flex gap-3"
                  :style="{ top: row.top + 'px' }"
                >
                  <div
                    v-for="p in row.photos"
                    :key="p.id"
                    @click="onCellClick(p)"
                    @pointerenter="onCellHover(p)"
                    @pointerdown="onCellPointerDown(p, $event)"
                    @pointermove="onCellPointerMove"
                    @pointerup="onCellPointerUp"
                    @pointercancel="onCellPointerUp"
                    @pointerleave="onCellPointerUp"
                    class="shrink-0 rounded-lg overflow-hidden bg-bg border cursor-pointer group relative photo-cell select-none"
                    :class="selectMode && isSelected(p.id) ? 'border-info ring-2 ring-info' : 'border-border'"
                    :style="cellStyle"
                    :data-cell-id="p.id"
                  >
                    <VideoThumb v-if="isVideo(p)" :src="thumbSrc(p)" />
                    <!-- 缩略图未就绪时不渲染 <img>：先挂一张空图、等 blob 到了再赋值 src，
                         浏览器会把 src 变化当成换图、清帧重解码，画面上就是「图片在圆角框里闪一下」。
                         顺便去掉 loading="lazy" —— 虚拟滚动已把挂载范围压到视口 ±900px，
                         再叠一层浏览器懒加载等于让这 900px 缓冲白留，图片反而更晚出现。

                         加载失败时**不移除** <img>，只把它藏起来（opacity-0）：
                         重试靠 src 里的 &r=N 变化触发，<img> 不在 DOM 里就没人重新发请求。 -->
                    <img
                      v-if="!isVideo(p) && thumbSrc(p)"
                      :src="thumbSrc(p)"
                      :alt="p.file_name"
                      class="w-full h-full object-cover"
                      :class="thumbBroken.has(p.id) ? 'opacity-0' : ''"
                      decoding="async"
                      draggable="false"
                      @error="onThumbError($event, p.id)"
                      @load="onThumbLoad(p.id)"
                    />
                    <!-- 占位层：图还没到 / 加载失败时盖在格子上。
                         以前这里什么都不画，<img> 加载失败后浏览器会把 alt 文本（文件名）
                         和破图图标一起渲染出来 —— 就是用户看到的「裂缝」。 -->
                    <div
                      v-if="!isVideo(p) && (!thumbSrc(p) || thumbBroken.has(p.id))"
                      class="thumb-ph absolute inset-0 flex flex-col items-center justify-center gap-1 px-2 text-center select-none text-text-muted"
                    >
                      <svg viewBox="0 0 160 160" class="w-7 h-7 opacity-40 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="6">
                        <circle cx="80" cy="68" r="17" />
                        <path d="M28 132 Q50 96 80 118 T162 98" />
                      </svg>
                      <span class="text-[11px] leading-tight">{{ thumbPhTitle(p.id) }}</span>
                      <span class="text-[10px] leading-tight opacity-75">可直接点击此处查看原图</span>
                    </div>
                    <!-- 多选态：左上角勾选标记 -->
                    <span
                      v-if="selectMode"
                      class="absolute top-1.5 left-1.5 z-10 w-5 h-5 rounded-md border-2 flex items-center justify-center text-[11px] leading-none"
                      :class="isSelected(p.id) ? 'bg-info border-info text-text-inverse' : 'bg-black/25 border-white/85 text-transparent'"
                    >✓</span>
                    <div class="photo-mask" :class="{ 'photo-mask--sel': selectMode && isSelected(p.id) }"></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>

          <!-- 右侧年份刻度尺：拖动手柄直接定位到对应日期 -->
          <AlbumYearRuler
            :items="rulerItems"
            :total="totalH"
            :scroll-top="scrollTop"
            :client-h="clientH"
            @seek="seekTimeline"
          />
        </div>
      </div>
    </div>

    <!-- ==================== 相册：封面卡片 ==================== -->
    <div v-else class="flex-1 min-h-0 flex flex-col">

      <EmptySnapshot
        v-if="albums.length === 0"
        class="flex-1"
        icon="album"
        text="还没有相册"
        min-height="320px"
        action-text="新建相册"
        action-icon="folder"
        @action="openNewAlbum"
      />

      <div v-else class="flex-1 min-h-0 overflow-auto pr-1">
        <div class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-5">
          <div
            v-for="a in albums" :key="a.id"
            :data-row-id="a.id"
            @click="onAlbumCardClick(a)"
            class="bg-surface rounded-2xl border border-border p-2.5 transition-theme hover:shadow-card hover:border-primary/40 group relative"
            :class="[
              selectMode && a.kind !== 'virtual' ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
              selectMode && isAlbumSelected(a.id) ? 'border-info ring-2 ring-info' : ''
            ]"
            :title="selectMode
              ? (a.kind === 'virtual' ? '点击选择 / 取消选择（虚拟相册可合并）' : '文件夹相册不能参与合并')
              : `查看「${a.name}」的照片`"
          >
            <!-- 相册多选态：左上角勾选标记；文件夹相册只显示禁用态 -->
            <span
              v-if="selectMode"
              class="absolute top-3.5 left-3.5 z-10 w-5 h-5 rounded-md border-2 flex items-center justify-center text-[11px] leading-none"
              :class="isAlbumSelected(a.id) ? 'bg-info border-info text-text-inverse' : 'bg-black/25 border-white/85 text-transparent'"
            >✓</span>
            <!-- 封面：最新一张图片的缩略图，四角圆角 -->
            <div class="aspect-[4/3] rounded-xl overflow-hidden bg-bg relative">
              <span v-if="a.kind === 'virtual'" class="absolute top-1.5 right-1.5 z-10 px-1.5 py-0.5 rounded text-[10px] bg-black/45 text-white">虚拟</span>
              <img
                v-if="a.cover_photo_id"
                :src="coverSrc(a)"
                alt=""
                class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                loading="lazy"
                decoding="async"
                @error="onThumbError($event)"
              />
              <div v-else class="w-full h-full flex flex-col items-center justify-center gap-1 text-text-muted text-xs">
                <IconGlyph name="folder" :size="22" />
                <span>暂无图片</span>
              </div>
            </div>
            <div class="px-1 pt-2.5 pb-1">
              <p class="font-medium text-text truncate">{{ a.name }}</p>
              <p class="text-xs text-text-muted mt-1">共 {{ a.photo_count || 0 }} 个媒体</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 多选浮窗：固定在页面底部，与时间轴 / 相册视图重叠（不占列表高度） -->
    <!-- 外层只负责水平居中，内层只做竖直弹入，避免动画过程中水平位移 -->
    <Transition name="select-float">
      <div v-if="selectMode" class="absolute bottom-1 left-1/2 -translate-x-1/2 z-30">
        <div class="select-float-panel flex items-center gap-2 px-4 py-2.5 rounded-full bg-surface border border-border shadow-lg">
          <!-- 相册视图：选中的是虚拟相册，动作为合并 -->
          <template v-if="activeTab === 'gallery'">
            <span class="text-sm text-text whitespace-nowrap">已选 <span class="font-semibold tabular-nums">{{ selectedAlbumCount }}</span> 个相册</span>
            <button @click="clearSelection" class="px-3 py-1 rounded-full bg-surface-hover text-text border border-border text-sm transition-theme whitespace-nowrap">取消选择</button>
            <button
              @click="mergeSelectedAlbums"
              :disabled="selectedAlbumCount < 2 || merging"
              class="px-3 py-1 rounded-full bg-info hover:bg-info-hover text-text-inverse text-sm transition-theme whitespace-nowrap disabled:opacity-50"
              title="把选中的虚拟相册合并成一个新虚拟相册（不移动磁盘文件）"
            >{{ merging ? '合并中…' : `合并相册（${selectedAlbumCount}）` }}</button>
            <button @click="exitSelectMode" class="px-3 py-1 rounded-full bg-surface-hover text-text border border-border text-sm transition-theme whitespace-nowrap">退出多选</button>
          </template>
          <!-- 时间轴视图：选中的是照片，动作为移动到其他相册 -->
          <template v-else>
            <span class="text-sm text-text whitespace-nowrap">已选 <span class="font-semibold tabular-nums">{{ selectedCount }}</span> 张</span>
            <button @click="selectAllPhotos" :title="hasUnloadedGroups ? '相册照片按日期分页加载，全选只包含已加载的部分；继续往下滚可以加载更多' : ''" class="px-3 py-1 rounded-full bg-surface-hover text-text border border-border text-sm transition-theme whitespace-nowrap">{{ hasUnloadedGroups ? '全选已加载' : '全选' }}</button>
            <button @click="clearSelection" class="px-3 py-1 rounded-full bg-surface-hover text-text border border-border text-sm transition-theme whitespace-nowrap">取消选择</button>
            <button
              @mouseenter="prefetch(loadMoveAlbumDialog)"
              @click="openMove"
              :disabled="!selectedCount"
              class="px-3 py-1 rounded-full bg-info hover:bg-info-hover text-text-inverse text-sm transition-theme whitespace-nowrap disabled:opacity-50"
              title="把选中的照片索引移动到其他相册（不移动磁盘文件）"
            >移动到相册（{{ selectedCount }}）</button>
            <button @click="exitSelectMode" class="px-3 py-1 rounded-full bg-surface-hover text-text border border-border text-sm transition-theme whitespace-nowrap">退出多选</button>
          </template>
        </div>
      </div>
    </Transition>

    <!-- 新建相册弹窗（文件夹 / 其他相册两种来源），懒加载 -->
    <NewAlbumDialog
      v-if="newAlbumMounted"
      :visible="newAlbumVisible"
      :albums="albums"
      @close="newAlbumVisible = false"
      @created="onAlbumCreated"
    />

    <!-- 管理相册弹窗（相册增删排序），懒加载 -->
    <AlbumManageDialog
      v-if="manageMounted"
      :visible="showManage"
      @close="showManage = false"
      @changed="onAlbumsChanged"
    />

    <!-- 任务管理弹窗（后台扫描任务列表 + 更新文件夹照片），懒加载 -->
    <AlbumTaskDialog
      v-if="taskMounted"
      :visible="showTask"
      @close="showTask = false"
      @changed="onAlbumsChanged"
    />

    <!-- 移动到其他相册弹窗（时间轴长按多选后使用），懒加载 -->
    <MoveAlbumDialog
      v-if="moveMounted"
      :visible="moveVisible"
      :albums="albums"
      :current-album-id="activeAlbumId"
      :photo-ids="selectedPhotoIds"
      @close="moveVisible = false"
      @moved="onPhotosMoved"
    />

    <!-- 导出相册索引弹窗（复用 ExportExcel），懒加载 -->
    <ExportAlbumIndex
      v-if="exportMounted"
      :is-visible="exportVisible"
      :albums="albums"
      @update:is-visible="exportVisible = $event"
    />

    <!-- 媒体查看器（图片 / 视频） -->
    <Teleport to="body">
    <Transition name="preview">
    <!-- 配色走 .album-viewer 的 CSS 变量：默认深色灯箱，毛玻璃主题下换成浅色玻璃（见 style 块） -->
    <div v-if="viewer" class="fixed inset-0 z-[10004] flex flex-col album-viewer" @click.self="closeViewer">
      <!-- 媒体区 + 信息面板的外层：flex 行。面板展开时靠宽度动画把媒体区【压窄】（而不是盖上去），
           图片因此会在剩下的空间里重新居中。媒体区必须 min-w-0：flex 子项默认 min-width:auto，
           会被图片的固有宽度撑住，那样面板再怎么变宽也挤不动它。 -->
      <div class="viewer-main flex-1 flex min-h-0">
      <!-- 媒体舞台：关闭按钮和左右箭头都挂在这一层，定位相对它而不是整个查看器。
           这样面板挤压时按钮【跟着布局自然移动】，不必再给 right 加第二条动画去跟宽度动画对齐
           （两套时间函数稍有出入就会有可见的错位）。 -->
      <div class="viewer-stage flex-1 min-w-0 relative">
      <!-- 关闭按钮（媒体区右上角） -->
      <button @click="closeViewer" class="z-20 w-10 h-10 rounded-full viewer-btn viewer-close text-lg flex items-center justify-center transition-theme" title="关闭">✕</button>
      <!-- 上一张（媒体区左侧边缘居中） -->
      <button @click="prevPhoto" class="z-20 w-11 h-11 rounded-full viewer-btn viewer-nav viewer-nav-prev text-xl flex items-center justify-center transition-theme" title="上一张">‹</button>
      <!-- 下一张（媒体区右侧边缘居中） -->
      <button @click="nextPhoto" class="z-20 w-11 h-11 rounded-full viewer-btn viewer-nav viewer-nav-next text-xl flex items-center justify-center transition-theme" title="下一张">›</button>
      <!-- 视频播放区 -->
      <div
        v-if="isVideo(viewer)"
        class="absolute inset-0 flex items-center justify-center p-6 overflow-hidden preview-media"
        :class="mediaReady ? 'media-in' : 'media-waiting'"
      >
        <video
          ref="videoEl"
          class="max-w-full max-h-full bg-black outline-none viewer-media"
          :src="photoSrc(viewer)"
          @timeupdate="onTimeupdate"
          @loadedmetadata="onLoadedmetadata"
          @loadeddata="mediaReady = true"
          @play="playing = true"
          @pause="playing = false"
          @ended="playing = false"
        ></video>
      </div>
      <!-- 图片查看区：滚轮缩放与拖动平移都只挂在外层容器上。
           原来 img 上还挂了一份重复 wheel 监听，多出来的非 passive 监听既浪费又会在
           devtools 里刷 Violation 提示；拖动用 setPointerCapture，甩出舞台也能继续拖。 -->
      <div
        v-else
        ref="stageEl"
        class="absolute inset-0 flex items-center justify-center p-6 overflow-hidden preview-media viewer-pan-surface"
        :class="[mediaReady ? 'media-in' : 'media-waiting', stageClass]"
        @wheel.prevent="onZoomWheel"
        @pointerdown="onPanDown"
        @pointermove="onPanMove"
        @pointerup="onPanUp"
        @pointercancel="onPanCancel"
      >
        <img
          ref="mediaEl"
          :src="photoSrc(viewer)"
          class="max-w-full max-h-full select-none transition-transform duration-100 viewer-media"
          :class="mediaClass"
          :style="viewerStyle"
          draggable="false"
          decoding="async"
          @load="mediaReady = true"
          @error="mediaReady = true"
        />
      </div><!-- /preview-media -->
      </div><!-- /viewer-stage -->

      <!-- 照片信息侧边栏（挤压式）：和媒体区同处 viewer-main 这个 flex 行里，宽度 0 → --info-w 时
           媒体区被压窄、图片在剩余空间里重新居中（是「挤」不是「盖」）。
           放进 flex 行还让面板高度天然等于媒体区高度，不会伸到下面把工具条盖住。
           常驻 DOM、靠 .open 开合；若用 v-if，宽度动画就没有起点，会一开一关地闪。 -->
      <aside class="info-panel" :class="{ open: infoVisible }">
        <div class="info-panel-inner">
          <div class="info-head">
            <span class="info-title">照片信息</span>
            <button @click="infoVisible = false" class="info-close" title="关闭">✕</button>
          </div>
          <div v-if="infoLoading" class="info-loading">读取中…</div>
          <template v-else>
            <section class="info-sec">
              <h4 class="info-sec-title">基础信息</h4>
              <dl class="info-list">
                <div class="info-row"><dt>文件名</dt><dd>{{ photoInfo?.fileName || viewer.file_name || '未知' }}</dd></div>
                <div class="info-row"><dt>路径</dt><dd>{{ photoInfo?.filePath || viewer.file_path || '未知' }}</dd></div>
                <div class="info-row"><dt>大小</dt><dd>{{ fmtBytes(photoInfo?.fileSize ?? viewer.file_size) || '未知' }}</dd></div>
              </dl>
            </section>
            <section class="info-sec">
              <h4 class="info-sec-title">照片信息</h4>
              <dl class="info-list">
                <div class="info-row"><dt>色域</dt><dd>{{ photoInfo?.colorSpace || '未知' }}</dd></div>
                <div class="info-row"><dt>分辨率</dt><dd>{{ infoSize }}</dd></div>
                <div class="info-row"><dt>拍摄时间</dt><dd>{{ photoInfo?.takenAt || '未知' }}</dd></div>
                <div class="info-row"><dt>拍摄设备</dt><dd>{{ photoInfo?.camera || '未知' }}</dd></div>
                <div class="info-row"><dt>地点</dt><dd>{{ infoGps }}</dd></div>
              </dl>
            </section>
          </template>
        </div>
      </aside>
      </div><!-- /viewer-main -->

      <!-- 底部工具条：在 viewer-main 之外，横贯全宽，不随侧边栏挤压 -->
      <div class="flex items-center justify-center gap-3 p-4 flex-wrap viewer-bar">
        <!-- 视频控制 -->
        <template v-if="isVideo(viewer)">
          <button @click="togglePlay" class="w-10 h-10 rounded-full viewer-btn text-sm transition-theme" :title="playing ? '暂停' : '播放'">{{ playing ? '⏸' : '▶' }}</button>
          <button @click="skip(-10)" class="h-10 px-3 rounded-full viewer-btn text-xs transition-theme" title="后退 10 秒">« -10s</button>
          <div class="flex items-center gap-2 min-w-[260px] max-w-full">
            <span class="viewer-fg text-xs tabular-nums w-12 text-right">{{ fmtTime(currentTime) }}</span>
            <input
              type="range"
              class="flex-1 accent-info"
              min="0"
              :max="duration || 0"
              step="0.1"
              :value="currentTime"
              @input="onSeekInput"
              @pointerdown="dragging = true"
              @pointerup="dragging = false"
            />
            <span class="viewer-fg text-xs tabular-nums w-12">{{ fmtTime(duration) }}</span>
          </div>
          <button @click="skip(10)" class="h-10 px-3 rounded-full viewer-btn text-xs transition-theme" title="前进 10 秒">+10s »</button>
          <AppSelect v-model="playbackRate" @change="changeRate" class="w-20" title="播放倍数" :options="[{ value: 0.5, label: '0.5x' }, { value: 0.75, label: '0.75x' }, { value: 1, label: '1x' }, { value: 1.25, label: '1.25x' }, { value: 1.5, label: '1.5x' }, { value: 2, label: '2x' }]" />
          <span class="viewer-sep">|</span>
        </template>
        <!-- 图片控制 -->
        <template v-else>
          <button @click="rotate(-1)" class="w-10 h-10 rounded-full viewer-btn text-sm transition-theme">⟲</button>
          <button @click="rotate(1)" class="w-10 h-10 rounded-full viewer-btn text-sm transition-theme">⟳</button>
          <button @click="zoomOut" class="w-10 h-10 rounded-full viewer-btn transition-theme">−</button>
          <span class="viewer-fg text-xs w-14 text-center">{{ Math.round(zoom * 100) }}%</span>
          <button @click="zoomIn" class="w-10 h-10 rounded-full viewer-btn transition-theme">＋</button>
          <button @click="resetView" class="px-3 h-10 rounded-full viewer-btn text-xs transition-theme">复位</button>
          <span class="viewer-sep">|</span>
        </template>
        <button @click="toggleInfo" class="px-4 h-10 rounded-full viewer-btn text-sm transition-theme">信息</button>
        <button @click="saveAs(viewer)" class="px-4 h-10 rounded-full viewer-btn text-sm transition-theme">另存</button>
        <button @click="openFolderViewer" class="px-4 h-10 rounded-full viewer-btn text-sm transition-theme">打开文件夹</button>
        <button @click="deletePhoto(viewer)" class="px-4 h-10 rounded-full bg-danger hover:bg-danger/80 text-white text-sm transition-theme">删除（回收站）</button>
      </div>
    </div>
    </Transition>
    </Teleport>
  </div>
</template>

<script setup vapor>
import { prefetch } from '../utils/dialogPrefetch.js'
import { getToken } from '../utils/authStorage.js'
import { ref, computed, nextTick, onMounted, onActivated, onDeactivated, onBeforeUnmount, watch, defineAsyncComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import axios from 'axios'
import { recordUndo as recordUndoSpec } from '../utils/undoRecorder.js'
import { useNotification } from '../composables/useNotification.js'
import { reportError } from '../utils/reportError.js'
import { applyRouteRowFocus, createRowFocusHost } from '../composables/useRowFocus.js'
import { useUndoShortcut } from '../composables/useUndo.js'
import { useAlbumScan } from '../composables/useAlbumScan.js'
import { createLatest } from '../utils/latestOnly.js'
import { usePhotoTimeline } from '../composables/usePhotoTimeline.js'
import { visibleGridRows } from '../utils/albumGridRows.js'
import {
  UNKNOWN_DATE, pageBefore, groupCountOf, firstUnloadedIndex, mergePhotoGroups,
  buildGroupPlaceholders, syncGroupPlaceholders,
} from '../composables/albumPhotoPages.js'
import { useThumbBatch } from '../composables/useThumbBatch.js'
import { useDisposables } from '../utils/disposables.js'
import { useViewerPan } from '../composables/useViewerPan.js'
import VideoThumb from '../components/import-export/VideoThumb.vue'
import AppSelect from '../components/base/AppSelect.vue'
import ViewSwitch from '../components/base/ViewSwitch.vue'
import AlbumYearRuler from '../components/album/AlbumYearRuler.vue'
import EmptySnapshot from '../components/base/EmptySnapshot.vue'
import IconGlyph from '../components/base/IconGlyph.vue'
import { albumThumbUrl, albumFileUrl } from '../utils/albumMedia'
import { pad2 } from '../utils/dateTime.js'
import { getPhotoInfo, setPhotoInfo, clearPhotoInfo } from '../utils/photoInfoCache.js'
import '../styles/dialog-transition.css'
import { INVOKE } from '../electronChannels.js'

// 新建相册 / 相册管理 / 任务管理 / 相册索引导出四个弹窗按需加载（与分组管理等页面同一套约定）
const loadNewAlbumDialog = () => import('../components/dialogs/NewAlbumDialog.vue')
const NewAlbumDialog = defineAsyncComponent(loadNewAlbumDialog)
const loadAlbumManageDialog = () => import('../components/dialogs/AlbumManageDialog.vue')
const AlbumManageDialog = defineAsyncComponent(loadAlbumManageDialog)
const loadAlbumTaskDialog = () => import('../components/dialogs/AlbumTaskDialog.vue')
const AlbumTaskDialog = defineAsyncComponent(loadAlbumTaskDialog)
const loadMoveAlbumDialog = () => import('../components/dialogs/MoveAlbumDialog.vue')
const MoveAlbumDialog = defineAsyncComponent(loadMoveAlbumDialog)
const loadExportAlbumIndex = () => import('../components/import-export/ExportAlbumIndex.vue')
const ExportAlbumIndex = defineAsyncComponent(loadExportAlbumIndex)

// 视图切换（菜单栏右对齐的 ViewSwitch）：时间轴 = 原照片按日期分组页；相册 = 封面卡片
const VIEW_OPTIONS = [
  { value: 'timeline', label: '时间轴' },
  { value: 'gallery', label: '相册' }
]
const activeTab = ref('timeline')

const albums = ref([])
// 标题栏统计：照片总数 / 相册数 / 总占用（由后端按文件路径去重后返回）
const albumStats = ref({ photo_count: 0, album_count: 0, total_size: 0 })
const activeAlbumId = ref(null)
const groups = ref([])
const busyScan = ref(false)

// 弹窗
const newAlbumVisible = ref(false)
const newAlbumMounted = ref(false)
const showManage = ref(false)
const manageMounted = ref(false)
const showTask = ref(false)
const taskMounted = ref(false)
const moveVisible = ref(false)
const moveMounted = ref(false)
const exportVisible = ref(false)
const exportMounted = ref(false)

// 查看器
const viewer = ref(null)
const rotation = ref(0)
const zoom = ref(1)
// 平移作用在这两个元素上：舞台算可视余量，img 承载 transform
const stageEl = ref(null)
const mediaEl = ref(null)
// 媒体首帧就绪：驱动「进入动画」的起跑线（为什么不用 Transition 的 enter-active，见 style 块注释）。
// 首次打开为 false，等 img @load / video loadeddata 才置 true；翻页时直接为 true（不重播动画）。
const mediaReady = ref(false)

// 照片信息面板：只在点「信息」后才去后端读 EXIF/ICC（打开查看器时不读，省一次往返）。
// 同一张看过就进缓存，左右来回翻不会重复请求。
const infoVisible = ref(false)
const infoLoading = ref(false)
const photoInfo = ref(null)
// 1-4：缓存搬到 utils/photoInfoCache.js（200 条上限的 LRU + 换号清空），这里只读写

// 视频播放状态
const videoEl = ref(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const playbackRate = ref(1)
const dragging = ref(false)

const { waitScan, stopAll } = useAlbumScan()

const token = () => getToken() || ''
const authHeaders = () => ({ Authorization: 'Bearer ' + token() })

const VIDEO_RE = /\.(mp4|webm|mov|avi|mkv|m4v|ogv)$/i
function isVideo(p) {
  return p && VIDEO_RE.test(p.file_name || '')
}

// 用 id 动态拉取源文件（图片/视频），避免直接暴露绝对路径，也保持鉴权。
// 用稳定 URL（不带时间戳），让浏览器能正常缓存，避免每次渲染整批重载。
// 生产模式 file:// 协议下需补完整后端地址（apiUrl），否则 /api 会被解析到磁盘根目录。
// <img> 无法携带 Authorization 头，故由 utils/albumMedia 统一追加 ?token= 查询参数通过鉴权。
function photoSrc(p) {
  return albumFileUrl(p.id)
}

// 缩略图 URL 由 utils/albumMedia 统一拼（顺带带上缩略图缓存版本 v=，
// 尺寸/质量升级时靠它让浏览器旧缓存失效；否则 max-age 会把旧图留一天）
// 优先用批量预取拿到的 objectURL（少几百次 HTTP 往返），
// 没批量到的回落到单张 /thumb 接口（服务端现场生成，功能不变）。
/* 缩略图地址「一生只定一次」——这是「照片框不动、图片却在格子里跳 / 闪」的根治点。
 *
 * batchThumbUrl 返回三态：
 *   undefined  → 批量还在拿，先返回空串（模板据此不渲染 <img>）
 *   ''         → 服务端没缓存这张缩略图，回落到单张 /thumb 接口现场生成
 *   'blob:…'   → 已就绪
 *
 * 以前是 batchThumbUrl(p.id) || albumThumbUrl(p.id)：blob 没到时先挂一张 HTTP 图，
 * 120ms 后 blob 到了再把 src 换掉。浏览器把 src 变化当成「换了一张图」，
 * 清掉已解码的帧重新解码 —— 于是同一张照片先看见、再空一帧、再出现。
 * 现在一个 id 只会从 undefined 变成后两者之一，之后永不改变，
 * <img> 的 src 不会二次赋值，也就不会重解码。 */
function thumbSrc(p) {
  const u = batchThumbUrl(p.id)
  if (u === undefined) return ''
  return u || withThumbRetry(p.id)
}

// 相册卡片封面：后端已按「mtime 最新的一张图片」给出 cover_photo_id，直接用它的缩略图
function coverSrc(a) {
  return withThumbRetry(a.cover_photo_id)
}

// 缩略图生成失败/源文件缺失等导致的 404：换为中性占位图，避免网格出现破图图标
const THUMB_PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="100%" height="100%" fill="#f3f4f6"/><g fill="none" stroke="#d1d5db" stroke-width="4"><circle cx="80" cy="70" r="18"/><path d="M30 132 Q52 96 82 118 T160 100" fill="none"/></g></svg>`
)

/* 缩略图加载失败的自愈重试 —— 404 不等于「这张照片没有缩略图」。
 *
 * 两个常见来源：清理微缩图之后（整本相册零缓存），以及可见区一次要的图超出后端
 * 配额闸（超出的那部分转给扫描子进程生成，主进程当场返回 404「排队生成中」）。
 * 这两种都是**几秒内就会好**的短暂状态。
 *
 * 之前的写法是 error 就换中性占位图，而占位图是 data URI —— <img> 的 src 已经
 * 被 DOM 改成它了，而模板里 :src 算出来的仍是原来那个 URL，Vapor 比较后认为
 * 「没变化」就不碰 DOM，于是这个格子**永久空白**，刷新页面之前再也不会重试。
 *
 * 现在按 100 / 200 / 2400ms 退避重试（URL 加 &r=N，让浏览器真的重发，
 * 而不是沿用上一次的失败结果），三次都拿不到才认定这张确实没有图、贴占位图。 */
const THUMB_RETRY_MAX = 3
// 退避梯度（毫秒），按「先抢快、再兜底」排：
//   100 / 200  —— 后端并发生成一屏图通常几百毫秒，头两次就是抢这个窗口，别让用户干等
//   2400       —— 前两次还没好的，多半是超出了同步配额、正由扫描子进程补，给足时间
// 早先的 600/1200/2400 用户实测「感觉挺久的」：明明图 300ms 就好了，却还要干等。
const THUMB_RETRY_DELAYS = [100, 200, 2400]
// photoId → 已重试次数（进 URL 参数，必须是响应式的：变了要重渲染 <img>）
const thumbRetry = ref(new Map())
// photoId → 这一刻是否「加载失败、正在显示占位层」。
// 和 thumbRetry 分开：thumbRetry 记「试了几次」，thumbBroken 记「现在该不该盖住那张破图」。
// 必须整体替换 Set —— Vapor 对 Set 的原位 add/delete 不敏感，不换引用界面不会变。
const thumbBroken = ref(new Set())
// photoId → 已排期到的次数。只用来防重复排期（同一轮失败会连发多个 error）。
const thumbRetryScheduled = new Map()
const thumbD = useDisposables()

function markThumbBroken(photoId, broken) {
  if (thumbBroken.value.has(photoId) === broken) return
  const s = new Set(thumbBroken.value)
  if (broken) s.add(photoId)
  else s.delete(photoId)
  thumbBroken.value = s
}

/* 占位层标题。两种状态：
 *   生成微缩图失败 —— 重试用尽（100 + 200 + 2400ms 都没拿到）
 *   正在生成微缩图 —— 其余情况，包括「批量请求还没回来」那几十毫秒
 *                     （它确实在路上了，不该报失败）
 *
 * 为什么不区分「超时」和「失败」：<img> 的 error 事件拿不到 HTTP 状态码，
 * 404（排队中）、超时、解码失败在浏览器看来是同一件事。硬造一个「超时」标签
 * 只能靠自己计时猜，会经常猜错 —— 那比统一文案更误导。 */
function thumbPhTitle(photoId) {
  return (thumbRetry.value.get(photoId) || 0) >= THUMB_RETRY_MAX
    ? '生成微缩图失败'
    : '正在生成微缩图'
}

function onThumbLoad(photoId) {
  markThumbBroken(photoId, false)
  // 只有「当前走的是单张接口」才打标：blob 命中的不需要（它在批量缓存里，
  // 本来就不会重新进批量），而且 blob 被内存回收后若还留在 loaded 里，
  // 这张图之后会永远拿不到图（load 里直接跳过它）。
  if (!batchThumbUrl(photoId)) markThumbLoaded(photoId)
}

function withThumbRetry(photoId) {
  const url = albumThumbUrl(photoId)
  const n = thumbRetry.value.get(photoId) || 0
  return n ? `${url}&r=${n}` : url
}

function onThumbError(e, photoId) {
  const id = photoId
  if (id == null) {
    // 相册封面：模板里没有占位层，退回贴 data URI 占位（保持原行为）
    if (e.target && e.target.src !== THUMB_PLACEHOLDER) e.target.src = THUMB_PLACEHOLDER
    return
  }
  /* 先把占位层盖上，**再**排重试。
   * 原来这里是「重试期间 return，什么都不做」—— 图一直处于加载失败状态，
   * 浏览器就会把 alt 文本（文件名）和破图图标画出来，在 100/200/2400ms
   * 的重试窗口里一直显示，就是用户截图里那排「裂缝」。 */
  markThumbBroken(id, true)
  const n = thumbRetry.value.get(id) || 0
  if (n >= THUMB_RETRY_MAX) return // 用尽：占位层显示「生成微缩图失败」
  // 这一轮已经排过期了就不再排（同一个 <img> 可能连发多次 error）
  if ((thumbRetryScheduled.get(id) || 0) !== n) return
  thumbRetryScheduled.set(id, n + 1)
  thumbD.timeout(() => {
    const m = new Map(thumbRetry.value)
    m.set(id, n + 1)
    // src 变成 &r=n+1 → <img> 真的重新发请求；成功时 @load 会把占位层撤掉
    thumbRetry.value = m
  }, THUMB_RETRY_DELAYS[Math.min(n, THUMB_RETRY_DELAYS.length - 1)])
}

function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '0:00'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${pad2(s)}`
}

const activeAlbum = computed(() => albums.value.find(a => a.id === activeAlbumId.value))
// 虚拟相册没有绑定文件夹，索引来自别的相册，刷新/重扫对它没有意义
const activeAlbumIsVirtual = computed(() => activeAlbum.value?.kind === 'virtual')
// 旋转必须走 rotation 这个 ref：曾经把角度存在 viewer.value._rot 上（普通字段），
// computed 追踪不到它 → 点旋转按钮改完角度也不重渲染，按钮看起来像坏的。
// 现在 transform 由 useViewerPan 统一产出（多一条 translate），依然必须依赖这两个 ref。
// 全部解构到 <script setup> 顶层再交给模板：Vapor 模板只认顶层绑定，
// 写成 pan.onPointerMove 这类嵌套访问不会自动解包里面的 ref。
const {
  style: viewerStyle, stageClass, mediaClass,
  onPointerDown: onPanDown, onPointerMove: onPanMove,
  onPointerUp: onPanUp, onPointerCancel: onPanCancel,
  reset: resetPan,
} = useViewerPan({ zoom, rotation, stageRef: stageEl, mediaRef: mediaEl })

/* ===== 网格窗口化虚拟滚动 =====
 * 逻辑已抽到 composables/usePhotoTimeline.js（与「选择照片」弹窗共用）：
 * 以“日期分组”为窗口单元，外部用总高度撑起滚动条，内部只挂载视口附近（含缓冲）的分组。 */
const {
  containerRef, scrollTop, clientH, cellStyle, totalH, visibleGroups, layout, resizing,
  cols, cell, gridGeom,
  measure, onScroll, onResize, reset: resetTimeline,
} = usePhotoTimeline(groups)

/* ===== 组内也做虚拟滚动：只渲染视口附近的那几行 =====
 * visibleGroups 只裁剪到「哪几天」，一天几千张时那一组仍会全部渲染。
 * 按行裁剪后 DOM 里的格子数从「几千」降到「一屏几十」，改窗口大小时的全量重排、
 * measureViewportIds 的逐个 getBoundingClientRect、FLIP 的遍历成本一起降下来。
 * 几何常量与列数全部来自 usePhotoTimeline，和 groupHeight / layout 同源。 */
const renderedGroups = computed(() => {
  const st = scrollTop.value
  const h = clientH.value
  const c = cols.value
  const sz = cell.value
  return visibleGroups.value.map(v => ({
    date: v.g.date,
    g: v.g,
    offset: v.offset,
    ...visibleGridRows({
      offset: v.offset, count: v.g.count, photos: v.g.photos,
      scrollTop: st, clientH: h, cols: c, cell: sz, ...gridGeom,
    }),
  }))
})

/* ===== 右侧年份刻度尺 =====
 * 刻度尺的定位基准就是 layout 里的分组偏移（每个分组带 date + offset），
 * 拖动手柄时按目标偏移写回容器 scrollTop，容器滚动再驱动刻度尺同步。 */
const rulerItems = computed(() => layout.value.items.map(v => ({ date: v.g.date, offset: v.offset })))

function seekTimeline(offset) {
  const el = containerRef.value
  if (!el) return
  el.scrollTop = Math.max(0, Math.min(offset, el.scrollHeight - el.clientHeight))
}

// 分组标题旁的来源标记：整组都有 EXIF 时不显示（「未知时间」组由后端统一命名，
// 那里必然全是回退项，再标一次是冗余）；只有正常日期组里混进了无 EXIF 的照片才提示。
function groupDateHint(g) {
  if (g.date === UNKNOWN_DATE) return ''
  const ps = g.photos || []
  if (!ps.length) return ''
  const exifCount = ps.filter(p => p.date_src === 'exif').length
  if (exifCount === ps.length) return ''
  const rest = ps.length - exifCount
  return `${rest} 张未知时间`
}

/* ===== 缩略图批量预取 =====
 * 可视区的照片 id 变化时，一次批量取回缩略图（转 objectURL 给 <img> 用），
 * 免得几十上百个 <img> 各自发一次请求（受浏览器同源并发连接数限制）。
 * 批量没取到的（服务端还没缓存缩略图）自动回落到单张 /thumb 接口，功能不变。
 * 实测：批量 0.19 ms/张 vs 逐个并发 2.43 ms/张。 */
/* 批量预取要哪些 id：**只取真正在视口里的格子**，不按日期分组取。
 *
 * 以前是按 visibleGroups 取「每个可见组的全部照片」。而一个组就是一天 ——
 * 一屏常常压着 2~3 天，一次就要出去好几百个 id（再按 CHUNK=100 分几轮发）。
 * 清理微缩图之后这些全要现场生成：用户滑走时这批还在跑，新滑到的一屏只能排队，
 * 这就是「想插队」的由来。
 *
 * 现在改成 DOM 实测：滚动容器里带 data-cell-id 的格子，谁的矩形和视口相交就取谁，
 * 上下各留 VIEWPORT_PAD（约两行，滚动时不至于一格一格地追）。
 * 典型一屏 20 张 → 请求量 40 张上下，一屏的量级。
 *
 * 「挂载范围」仍由 usePhotoTimeline 的 900px 缓冲决定，两者互不影响：
 * 挂了但没请求的格子，thumbUrlFor 返回 undefined，`<img>` 根本不渲染（不会出破图），
 * 滚过去时这里量到就会补请求。 */
const VIEWPORT_PAD = 480
const viewportPhotoIds = ref([])
let viewportTimer = 0
let lastMeasureAt = 0
function measureViewportIds() {
  const el = containerRef.value
  if (!el) return
  const box = el.getBoundingClientRect()
  const padTop = box.top - VIEWPORT_PAD
  const padBottom = box.bottom + VIEWPORT_PAD
  /* 分两档收集，**视口内的排在前面**：
   *   ① inView：矩形真的落在可视区内 —— 用户眼睛正盯着这十几张
   *   ② buffer：只有加上下各 480px 才相交 —— 在屏幕外，滚过去才看得到
   * 请求列表按这个顺序发出去，后端就按这个顺序生成（`missing` 按请求序 push，
   * 再按 GEN_BATCH 分批），所以视口内先返回、缓冲带后补。
   *
   * 不分档的话就是纯 DOM 顺序 —— 缓冲带里屏幕外那二十几张会和视口内靠下的
   * 几张抢同一批生成槽，用户明明在盯着看的那格却要等到最后。 */
  const inView = []
  const buffer = []
  for (const node of el.querySelectorAll('[data-cell-id]')) {
    const r = node.getBoundingClientRect()
    if (r.bottom < padTop || r.top > padBottom) continue
    const id = Number(node.dataset.cellId)
    // querySelectorAll 是文档顺序，所以两档内部都是「从上到下」，符合阅读顺序
    if (r.bottom >= box.top && r.top <= box.bottom) inView.push(id)
    else buffer.push(id)
  }
  const out = inView.concat(buffer)
  const prev = viewportPhotoIds.value
  // 只在真的变了才写：scrollTop 每帧都在动，无脑赋值会让下游 watch 每帧醒一次。
  // 逐项比较包含顺序 —— 顺序现在有意义（视口内优先），不能只比长度。
  if (prev.length !== out.length || prev.some((v, i) => v !== out[i])) viewportPhotoIds.value = out
}
// 节流 80ms；尾部必须补一次（否则最后一次滚动被吞，视口里的图永远不请求）
function scheduleMeasure() {
  /* 拖动窗口期间**不重测视口**：布局每帧都在变，测出来的 id 序列每帧都不同，
   * 下游 useThumbBatch 会把它当成「用户滑走了」而 abort 正在生成的批量请求，
   * 于是后端刚解码到一半就被掐断、下一帧又从头来 —— 拖多久就卡多久。
   * 布局本身照旧跟手（usePhotoTimeline 的 measure 不受影响），这里冻结的只是
   * 「视口里有哪些格子」这个判断：拖动时眼睛看的基本还是原来那批照片。 */
  if (resizing.value || viewportTimer) return
  const wait = Math.max(0, 80 - (Date.now() - lastMeasureAt))
  viewportTimer = setTimeout(() => {
    viewportTimer = 0
    if (resizing.value) return // 定时器是在拖动开始前排的，此刻可能已经进安静窗口
    lastMeasureAt = Date.now()
    measureViewportIds()
  }, wait)
}
// 松手后必须补测一次：拖动期间视口范围、列数都变了，冻结期间攒下的差异要结算。
// 少了这一条，改完窗口大小后新露出来的那几格会一直不请求缩略图。
watch(resizing, (v) => { if (!v) scheduleMeasure() })
// 滚动与分组变化都会改变「视口里有哪些格子」。
// flush:'post' 保证 DOM 已按新的 scrollTop / 新分组排好位置再量。
watch([scrollTop, visibleGroups], scheduleMeasure, { flush: 'post' })
thumbD.add(() => { if (viewportTimer) { clearTimeout(viewportTimer); viewportTimer = 0 } })

const {
  thumbUrlFor: batchThumbUrl,
  refresh: refreshThumbBatch,
  clear: clearThumbBatch,
  markLoaded: markThumbLoaded,
} = useThumbBatch(() => viewportPhotoIds.value)

async function loadAlbums(first = true) {
  // 相册列表失败原先直接抛到调用方（多为未处理的 Promise 拒绝），界面既不提示也不刷新；
  // 这里捕获后提示，并保留现有列表/选中相册，避免一次网络抖动把界面清空。
  try {
    const res = await axios.get('/api/album', { headers: authHeaders() })
    albums.value = res.data.data || []
    albumStats.value = res.data.stats || { photo_count: 0, album_count: albums.value.length, total_size: 0 }
    // 保持选中；相册被删则切到第一个
    if (!albums.value.find(a => a.id === activeAlbumId.value)) {
      activeAlbumId.value = albums.value.length ? albums.value[0].id : null
    }
    if (activeAlbumId.value) await loadPhotos(first)
  } catch (e) {
    reportError(e, { action: '加载相册列表' })
    console.error(e)
  }
}

// 标题栏体积显示：不足 1MB 用 KB，其余按 MB / GB（保留一位小数）
function formatSize(bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

// 拆成「数字 + 单位」两部分，单位与照片 / 相册的标签同字号
const sizeParts = computed(() => {
  const [value, unit = 'KB'] = formatSize(albumStats.value.total_size).split(' ')
  return { value, unit }
})

// 照片请求序号：切换相册/刷新时先发的请求可能后到，旧相册的照片不能写进新相册（B06-07）
const photosSeq = createLatest()

/* ===== 分页加载：先拿「日期索引」，再按需补照片行 =====
 *
 * 以前是一次 GET /photos 把整册照片拉下来 —— 五万张就是十几 MB JSON，
 * 而相册页是虚拟滚动，一屏其实只要十来个日期组。
 *
 * 现在分两步：
 *   ① GET /dates   → [{date, count}]，只有日期和每组张数（469 天也就十几 KB）
 *   ② GET /photos?days=8&before=D → 只取需要的那些天的照片行
 *
 * 为什么先要日期索引（而不是直接按页取）：总高度、年刻度尺、跳转位置全都依赖
 * 「一共有多少组、每组多高」。有了 count，布局一次算准，之后加载只填照片不改变高度，
 * 滚动条不会随加载一下一下变长。
 *
 * 分页口径保证「同一天绝不跨页」（后端按天累加），所以合并时只需按 date 整组替换，
 * 不存在「某天加载了一半」的中间态。
 */
const PAGE_DAYS = 8
// 正在请求的锚点日期：滚动会连续触发 ensureLoaded，同一段别重复发
const pageInFlight = new Set()
// 每次重载（切相册/刷新）自增：晚到的旧请求不能把照片写进新的一批分组
let loadEpoch = 0
// 当前 groups 属于哪本相册：对账（sync）只在同一本相册内做，跨相册必须重建
let groupsAlbumId = null

// 日期步进 / 页锚点 / 整组合并 / 组头张数 都在纯函数模块里（可 node 单测），
// 这里只负责发请求与把结果写回响应式分组。
async function ensureLoaded(fromIdx) {
  const gs = groups.value
  const j = firstUnloadedIndex(gs, fromIdx)
  if (j === -1) return
  const albumAtStart = activeAlbumId.value
  const epoch = loadEpoch
  const anchorDate = gs[j].date
  if (pageInFlight.has(anchorDate)) return
  pageInFlight.add(anchorDate)
  try {
    const res = await axios.get(`/api/album/${albumAtStart}/photos`, {
      params: { days: PAGE_DAYS, before: pageBefore(anchorDate) },
      headers: authHeaders(),
    })
    // 期间换了相册或重载过：这批属于上一批分组，写进去就是张冠李戴
    if (epoch !== loadEpoch || albumAtStart !== activeAlbumId.value) return
    if (mergePhotoGroups(groups.value, res.data && res.data.data)) {
      refreshThumbBatch()
      /* 合并完必须主动再查一次「视口里还有没有没加载的组」。
         不能指望 watch(visibleGroups) 再触发一次：合并只改 photos，
         而 count 通常等于原值 —— layout 与 visibleGroups 都不会重算，
         watcher 也就不会再跑。表现出来就是「第一页填不满一屏时停在『加载中…』，
         要手动滚一下才继续」。 */
      ensureVisibleLoaded()
    }
  } catch (e) {
    if (epoch !== loadEpoch) return
    reportError(e, { action: '加载照片' })
    console.error(e)
  } finally {
    pageInFlight.delete(anchorDate)
  }
}

async function loadPhotos(first = true) {
  const my = photosSeq.begin()
  if (!activeAlbumId.value) { groups.value = []; groupsAlbumId = null; return }
  /* 对账只能在同一本相册内做。
   * 日期字符串各相册之间高度重合（2026-11-12 这种），跨相册复用分组对象
   * 会把上一本的 photos 数组原样带过来 —— 表现是「切过去先看到别人的照片」。 */
  const albumId = activeAlbumId.value
  const sameAlbum = groupsAlbumId === albumId
  loadEpoch++
  pageInFlight.clear()
  try {
    const res = await axios.get(`/api/album/${albumId}/dates`, { headers: authHeaders() })
    // 期间已切到别的相册（或又刷新了一次）：这批已过期，丢弃
    if (!photosSeq.isCurrent(my)) return
    const rows = res.data && res.data.data
    // 对账而不是重建：扫描期间这个方法每 800ms 被调一次，
    // 整表重建会让所有格子卸载再挂载（用户看到整片闪）。见 syncGroupPlaceholders 的注释。
    groups.value = sameAlbum ? syncGroupPlaceholders(groups.value, rows) : buildGroupPlaceholders(rows)
    groupsAlbumId = albumId
    if (first) {
      // 切换相册/刷新后回到顶部并重新计量
      await nextTick()
      resetTimeline()
      // 新相册：从第一组开始填
      await ensureLoaded(0)
    } else {
      // 扫描期间的渐进刷新：只补视口里空着/张数变了的组，不碰滚动位置
      ensureVisibleLoaded()
    }
  } catch (e) {
    // 照片接口的失败在这里统一处理，避免被调用方误报成「相册列表加载失败」
    if (!photosSeq.isCurrent(my)) return
    reportError(e, { action: '加载照片' })
    console.error(e)
  }
}

// 视口里出现还没加载的分组就补上：初始填满一屏、往下滚、刻度尺跳转都靠这一条。
// flush:'post' —— 等 DOM 落位再发请求，避免刚 resetTimeline 就按旧 scrollTop 算一遍。
function ensureVisibleLoaded() {
  const list = visibleGroups.value
  if (!list.length) return
  const miss = list.find((v) => !v.g.photos)
  if (!miss) return
  const gi = groups.value.indexOf(miss.g)
  if (gi >= 0) ensureLoaded(gi)
}
watch(visibleGroups, ensureVisibleLoaded, { flush: 'post' })

function selectAlbum(id) {
  // 切相册时清空多选：不同相册的照片 id 不能混在一起移动
  if (activeAlbumId.value !== id) exitSelectMode()
  if (activeAlbumId.value !== id) {
    // 换了相册 → 旧的 objectURL 全作废（照片 id 不同，留着会显示错图）
    clearThumbBatch()
    // 重试计数同样作废：新相册的 id 会重用，留着会让新照片带着旧的 &r=N 参数
    thumbRetry.value = new Map()
    thumbRetryScheduled.clear()
    thumbBroken.value = new Set()
  }
  activeAlbumId.value = id
  // loadPhotos 内部已捕获并提示，这里不需要再包一层 catch。
  // 返回 Promise：跨页定位要在日期索引/占位分组就绪之后才能按日期算 scrollTop，
  // 调用方（applyPhotoFocus）需要 await；其余调用方忽略返回值，行为不变。
  return loadPhotos()
}

// 相册 tab 点卡片：切到时间轴，只看这个相册的照片（按日期分组排列）
function openAlbum(a) {
  activeTab.value = 'timeline'
  if (activeAlbumId.value === a.id) {
    // 已经是当前相册：只需回到顶部
    nextTick(() => resetTimeline())
  } else {
    selectAlbum(a.id)
  }
}

// 切换 Tab 后时间轴容器重新挂载，需要重新计量并恢复滚动位置
// （两个视图的多选对象不同，切换时统一退出多选）
watch(activeTab, async (v) => {
  exitSelectMode()
  if (v !== 'timeline') return
  await nextTick()
  measure()
  const el = containerRef.value
  if (el) el.scrollTop = scrollTop.value
})

// 跨页定位：/album?focus=<相册id>
const route = useRoute()
const router = useRouter()
// 行定位宿主：显式传路由对象（身份稳定供 useRowFocus 记签名；不再经实例代理）
const rowFocusHost = createRowFocusHost(route, router)
// 跨页定位：/album?photo=<照片id>（首页随机配图点进来）。
// 与 ?focus=<相册id> 分开：focus 是全局搜索定位「相册」，photo 定位「一张具体的图」；
// 两套 id 各自自增，照片 id 完全可能等于某个相册 id，共用一个参数会串台。
let focusingPhotoId = 0
async function applyPhotoFocus() {
  const raw = route.query.photo
  if (raw == null || raw === '') return
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) return
  // 首次挂载时 activated 可能早于 onMounted 里的 loadAlbums，此刻相册列表还没回来：
  // 直接返回且不清 query，等 onMounted 数据就绪后再调一次。
  if (!albums.value.length) return
  // 同一次跳转里 onActivated 与 watch(query) 各会触发一遍
  if (focusingPhotoId === id) return
  focusingPhotoId = id
  try {
    const res = await axios.get(`/api/album/photo/${id}/locate`, { headers: authHeaders() })
    const p = res.data && res.data.data
    if (!p) return
    activeTab.value = 'timeline'
    // 照片所在相册还在才切过去；相册被删/照片被移走时留在当前相册，只打开这张图
    if (p.album_id && albums.value.some(a => a.id === p.album_id) && activeAlbumId.value !== p.album_id) {
      await selectAlbum(p.album_id)
    }
    await nextTick()
    // 分组占位在 /dates 回来后就有，offset 不必等照片行加载完就能算准；
    // 滚过去后视口变化会由 watch(visibleGroups) 自动补上这一天的照片。
    const date = p.photo_date || UNKNOWN_DATE
    const hit = layout.value.items.find(v => v.g.date === date)
    if (hit) {
      seekTimeline(hit.offset)
      // 同步 ref：切 tab 的 watcher 会按 scrollTop.value 回写容器，不同步会被它拉回旧位置
      const el = containerRef.value
      if (el) scrollTop.value = el.scrollTop
    }
    // 直接打开这张图：locate 返回的列与网格照片同源，查看器和左右翻页都能用
    viewPhoto(p)
  } catch (_) {
    // 照片刚被删 / 接口失败：安静地留在相册页，别用报错打断跳转
  } finally {
    // 定位只做一次：清掉 query，回退/刷新/切回不再重复弹查看器
    const q = { ...route.query }
    delete q.photo
    router.replace({ path: route.path, query: q })
    focusingPhotoId = 0
  }
}

function applyFocus() {
  applyRouteRowFocus(rowFocusHost, {
    parse: (key) => {
      const id = Number(key)
      if (!albums.value.some((a) => a.id === id)) return null
      // 定位到某个相册时直接落在时间轴上，避免停在卡片列表看不出效果
      activeTab.value = 'timeline'
      if (activeAlbumId.value !== id) selectAlbum(id)
      return key
    },
  })
}

function openNewAlbum() {
  newAlbumMounted.value = true
  newAlbumVisible.value = true
}

// 新建成功：刷新列表并选中新相册（文件夹相册由 scanWatch 边扫边出图）
async function onAlbumCreated(id) {
  exitSelectMode()
  await loadAlbums(false)
  if (id) {
    activeAlbumId.value = id
    await loadPhotos(true)
  }
  // 踢一脚观察器立即探测：新相册的首次全量扫描马上进入快刷，不用等空闲周期
  scheduleScanWatch(0)
}

function openManage() {
  manageMounted.value = true
  showManage.value = true
}

// 任务管理：后台扫描任务（含软件自动发起的）都在这里看进度/停止，「更新文件夹照片」也在这个弹窗里
function openTask() {
  taskMounted.value = true
  showTask.value = true
}

function openExport() {
  exportMounted.value = true
  exportVisible.value = true
}

// 管理弹窗里增删/排序/扫描完成：重新拉列表与照片（不清滚动位置）
async function onAlbumsChanged() {
  await loadAlbums(false)
  await nextTick()
  measure()
}

// Ctrl+Z 撤销 / Ctrl+Shift+Z、Ctrl+Y 重做相册排序、相册增删与删除照片
// —— 撤销/重做后统一重载相册列表与当前相册照片，并拉取后台异步结果
useUndoShortcut('album', {
  onAfterUndo: async (label) => {
    await loadAlbums(false)
    useNotification().success(label ? `已撤销：${label}` : '已撤销')
  },
  onAfterRedo: async (label) => {
    await loadAlbums(false)
    // 重做（如重新加入文件夹）已在后端触发增量扫描，scanWatch 会让照片渐进显示
    pollScan()
    useNotification().success(label ? `已重做：${label}` : '已重做')
  }
})

async function refreshAll() {
  if (!activeAlbumId.value) return
  busyScan.value = true
  const isVirtual = activeAlbumIsVirtual.value
  try {
    // 虚拟相册没有文件夹，不能走增量扫描；后端按相册类型自行分流
    // （kind='virtual' → 只按已有索引更新拍摄时间与缩略图，不遍历磁盘、不增删行）。
    // 这里仍传 mode，后端优先看 kind。
    await axios.post(`/api/album/${activeAlbumId.value}/rescan`, { mode: 'incremental' }, { headers: authHeaders() })
    useNotification().info(isVirtual ? '已开始更新虚拟相册的照片信息…' : '已开始增量更新照片索引…')
    // 踢一脚观察器立即探测，扫描马上进入快刷
    scheduleScanWatch(0)
    await pollScan()
    /* 清掉重试计数再重拉数据。
     * 不这么做的话，「刷新」对已经贴了占位图的格子毫无作用：占位图是直接写进 DOM 的
     * data URI，而模板算出来的 src 仍是同一个 URL（&r=3），比较后「没变化」→ 不重设 →
     * 不重新请求。清空计数会让 URL 退回不带 &r= 的版本，值变了才会真的重发。
     * 只清计数、不动已拿到的 blob，避免整屏图重新解码闪一下。 */
    thumbRetry.value = new Map()
    thumbRetryScheduled.clear()
    // 占位层状态也要清：刷新的本意就是「再给这些图一次机会」，
    // 不清的话用尽重试的格子会一直挂着「生成微缩图失败」。
    thumbBroken.value = new Set()
    await loadAlbums()
    useNotification().success(isVirtual ? '虚拟相册已更新' : '照片索引已更新')
  } catch (err) {
    reportError(err, { action: '刷新' })
  } finally { busyScan.value = false }
}

// 渐进刷新统一由下面的 scanWatch 常驻观察器负责（任何入口发起的扫描都能兜住），
// 这里只负责「等到当前相册扫描结束」，供刷新按钮做完成提示。
function pollScan() {
  return waitScan(activeAlbumId.value)
}

/* ===== 扫描渐进刷新常驻观察器（扫描一点、显示一点）=====
 * 后台扫描是异步任务；以前只有「顶部刷新」等个别入口挂了轮询，新建相册、
 * 任务管理弹窗发起的扫描在页面上毫无动静，只能切走再切回才看到新照片。
 * 改成常驻观察器统一兜住所有入口：
 *   - 有扫描在跑 → 按 800ms（与 useAlbumScan 同节奏）重拉相册与当前照片；
 *   - 空闲 → 3s 低频探一次 /api/album/tasks，发现新扫描立即进入快节奏。
 * 页面被 KeepAlive 缓存时停表（onDeactivated），切回（onActivated）再开。 */
const SCAN_BUSY_MS = 800
const SCAN_IDLE_MS = 3000
let scanWatchTimer = 0
// 上一轮「当前相册是否有扫描在跑」：用于扫完瞬间补拉最后一次，
// 否则任务从 /tasks 消失的那轮不刷新，尾巴上的照片就丢了。
let scanWatchActiveRunning = false
// 停表标志：stopScanWatch 里的 clearTimeout 对**已经触发、正在 await** 的那次 tick 无效。
// 没有这个标志时，tick 从 await 回来后照样执行到末尾的 scheduleScanWatch —— 定时器复活，
// 组件 deactivated 甚至卸载后仍每 3s 轮询 /tasks 并写已卸载组件的状态。
let scanWatchStopped = false

async function scanWatchTick() {
  if (scanWatchStopped) return
  let running = []
  try {
    const res = await axios.get('/api/album/tasks', { headers: authHeaders() })
    running = (res.data.data || []).filter(t => t.scanning && !t.cancelled)
  } catch (_) {
    running = []
  }
  // await 期间可能已被停表（切走页面/卸载）：此时不能再写状态、更不能重新排定
  if (scanWatchStopped) return
  const activeRunning = running.some(t => t.albumId === activeAlbumId.value)
  // 本册在扫 → 本轮刷新；本册刚从「在扫」转「扫完」→ 补拉收尾
  if (activeRunning || (scanWatchActiveRunning && !activeRunning)) {
    await loadAlbums(false).catch(() => {})
    if (scanWatchStopped) return // 这第二个 await 之后同样要重新判断
  }
  scanWatchActiveRunning = activeRunning
  scheduleScanWatch(running.length ? SCAN_BUSY_MS : SCAN_IDLE_MS)
}

function scheduleScanWatch(ms) {
  if (scanWatchStopped) return
  clearTimeout(scanWatchTimer)
  scanWatchTimer = setTimeout(scanWatchTick, ms)
}

function startScanWatch() {
  if (scanWatchTimer) return
  scanWatchStopped = false
  // 立即探一次：进页面/切回来就能接上正在跑的扫描
  scheduleScanWatch(0)
}

function stopScanWatch() {
  scanWatchStopped = true
  clearTimeout(scanWatchTimer)
  scanWatchTimer = 0
  scanWatchActiveRunning = false
}

function openFolderViewer() {
  if (!viewer.value) return
  // 从 viewer 的 file_path 提取目录
  const fp = viewer.value.file_path || ''
  const idx = Math.max(fp.lastIndexOf('\\'), fp.lastIndexOf('/'))
  if (idx === -1) { useNotification().error('无法获取文件路径'); return }
  const dir = fp.substring(0, idx)
  window.electron.invoke(INVOKE.OPEN_FOLDER, dir).catch(() => useNotification().error('打开文件夹失败'))
}

// 当前相册的扁平照片列表（按日期分组展开），用于上下张切换
const allPhotos = computed(() => {
  const arr = []
  for (const g of groups.value) arr.push(...(g.photos || []))
  return arr
})

/* ===== 时间轴多选（长按或工具栏「多选」按钮进入）与「移动到相册」 =====
 * 长按照片 400ms 进入多选（与 GridView 的长按阈值一致）：按住的那张自动勾选，
 * 也可以点工具栏「多选」直接进入、再点照片切换勾选；多选态下单击照片不再打开查看器。
 * 多选只持有照片索引 id；移动时后端只改 album_photos 索引，绝不移动/修改磁盘文件。 */
const LONG_PRESS_MS = 400
const LONG_PRESS_TOLERANCE = 10
const selectMode = ref(false)
const selectedIds = ref(new Set())
let pressTimer = 0
let pressOrigin = null
// 长按触发后紧跟的那次 click 只用于收尾，不再当作「查看照片」
let suppressClick = false

const selectedCount = computed(() => selectedIds.value.size)
const selectedPhotoIds = computed(() => [...selectedIds.value])

/* ===== 相册视图多选（仅虚拟相册可参与合并） =====
 * 文件夹相册代表磁盘目录，合并会破坏它与目录的对应关系，因此不可勾选/合并。 */
const selectedAlbumIds = ref(new Set())
const selectedAlbumCount = computed(() => selectedAlbumIds.value.size)
const merging = ref(false)

function isAlbumSelected(id) { return selectedAlbumIds.value.has(id) }
function toggleAlbumSelect(id) {
  const next = new Set(selectedAlbumIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedAlbumIds.value = next
}
// 相册卡片点击：多选态下切换勾选（文件夹相册提示不可合并），否则正常打开时间轴
function onAlbumCardClick(a) {
  if (!selectMode.value) { openAlbum(a); return }
  if (a.kind !== 'virtual') { useNotification().info('文件夹相册不能参与合并，请选择虚拟相册'); return }
  toggleAlbumSelect(a.id)
}

// 合并选中的虚拟相册：后端合成一个新虚拟相册并删除源相册（只动索引，不碰磁盘文件）
async function mergeSelectedAlbums() {
  const ids = [...selectedAlbumIds.value]
  if (ids.length < 2) { useNotification().info('请至少选择两个虚拟相册'); return }
  merging.value = true
  try {
    const res = await axios.post('/api/album/merge', { album_ids: ids }, { headers: authHeaders() })
    // 合并原先不可撤销：源相册被删后只能重新建、重新扫。后端把「新相册 + 新照片索引 +
    // 每个源相册（整行 + 照片整行）」整包带回，这里登记成一条 album_merge 命令。
    const removed = res.data?.removed
    if (removed?.newAlbum) {
      recordUndoSpec({
        key: 'album',
        type: 'album_merge',
        label: `合并相册：${removed.newAlbum.name}`,
        payload: removed,
      })
    }
    exitSelectMode()
    await loadAlbums()
    useNotification().success(res.data?.message || '相册已合并')
  } catch (err) {
    reportError(err, { action: '合并相册' })
  } finally {
    merging.value = false
  }
}

function isSelected(id) { return selectedIds.value.has(id) }

function enterSelectMode(id) {
  selectMode.value = true
  if (id != null) {
    const next = new Set(selectedIds.value)
    next.add(id)
    selectedIds.value = next
  }
}

// 退出多选并清空勾选（切相册、切视图、移动/合并完成时调用）
function exitSelectMode() {
  if (!selectMode.value && selectedIds.value.size === 0 && selectedAlbumIds.value.size === 0) return
  selectMode.value = false
  selectedIds.value = new Set()
  selectedAlbumIds.value = new Set()
}

// 工具栏「多选」按钮：未进入时进入，已在多选时再点一下退出
function toggleSelectMode() {
  if (selectMode.value) exitSelectMode()
  else enterSelectMode()
}

function clearSelection() {
  selectedIds.value = new Set()
  selectedAlbumIds.value = new Set()
}

function selectAllPhotos() {
  const next = new Set()
  for (const p of allPhotos.value) next.add(p.id)
  selectedIds.value = next
  if (next.size) selectMode.value = true
}

// 有没有还没加载的日期组：分页后「全选」只能全选已加载的，按钮文案要说实话，
// 否则用户以为选中了整册、实际只选了看到的那一段。
const hasUnloadedGroups = computed(() => groups.value.some(g => !g.photos))

function toggleSelect(id) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function clearPressTimer() {
  if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0 }
}

// 按下开始计时：未移动且持续 LONG_PRESS_MS → 进入多选（鼠标/触屏统一走 pointer 事件）
function onCellPointerDown(p, e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  suppressClick = false
  pressOrigin = { x: e.clientX, y: e.clientY }
  clearPressTimer()
  pressTimer = setTimeout(() => {
    pressTimer = 0
    if (selectMode.value) return
    suppressClick = true
    enterSelectMode(p.id)
  }, LONG_PRESS_MS)
}

// 按住后移动超过阈值视为滚动/拖拽，取消长按
function onCellPointerMove(e) {
  if (!pressTimer || !pressOrigin) return
  if (Math.abs(e.clientX - pressOrigin.x) > LONG_PRESS_TOLERANCE || Math.abs(e.clientY - pressOrigin.y) > LONG_PRESS_TOLERANCE) clearPressTimer()
}

function onCellPointerUp() {
  clearPressTimer()
  pressOrigin = null
  // 指针离开/抬起时取消"还没触发"的悬停预取，避免在格子外白白下原图
  onCellHoverEnd()
}

function onCellClick(p) {
  if (suppressClick) { suppressClick = false; return }
  if (selectMode.value) { toggleSelect(p.id); return }
  viewPhoto(p)
}

// ---- 悬停预取原图（单槽）----
// 实测（testjs/probe/viewer-load-probe.cjs，4032x3024 / 3.38MB）：
//   全新 URL 直接加载到可见 149ms；用 new Image() 预热后只需 33ms，省 116ms。
// 为什么不用 fetch 预取：/file 返回 Cache-Control: no-cache 且没有 ETag/Last-Modified，
//   浏览器无法做条件请求，fetch 下完的字节 img 不认（实测仍走完整请求），纯属白花带宽。
// 为什么只留一张：原图解码成位图约 4032×3024×4 = 47MB，预热多张等于把内存堆在
//   "用户可能根本不点"的图上。单槽覆盖 → 最多一张常驻，且新悬停会中断上一张的下载。
const HOVER_PREFETCH_DELAY = 80 // 滤掉快速划过网格；80ms 比 150ms 更早开始下，代价是横穿时多开几次请求
let hoverTimer = null
let prefetchImg = null
let prefetchId = null

function releasePrefetch() {
  if (!prefetchImg) return
  // 置空 src 会中断还没下完的请求；已下完的位图交给浏览器/GC 回收
  prefetchImg.src = ''
  prefetchImg = null
}

function onCellHover(p) {
  // 多选态、已打开查看器时不预取：这两种状态下点开图不会立刻发生
  if (selectMode.value || viewer.value || isVideo(p)) return
  if (prefetchId === p.id) return // 槽位里就是这张，重复预取没意义
  clearTimeout(hoverTimer)
  hoverTimer = setTimeout(() => {
    hoverTimer = null
    releasePrefetch()
    prefetchId = p.id
    const im = new Image()
    im.decoding = 'async'
    // 失败就放弃这张，别让 prefetchId 卡在"预取过但没成功"的状态，否则永远不再重试
    im.onerror = () => {
      if (prefetchImg === im) { prefetchImg = null; prefetchId = null }
    }
    // URL 必须和查看器里的 photoSrc(viewer) 完全一致，多一个参数就命中不了 image cache
    im.src = albumFileUrl(p.id)
    prefetchImg = im
  }, HOVER_PREFETCH_DELAY)
}

function onCellHoverEnd() {
  clearTimeout(hoverTimer)
  hoverTimer = null
}

function openMove() {
  if (!selectedCount.value) {
    useNotification().warning('请先选择要移动的照片')
    return
  }
  moveMounted.value = true
  moveVisible.value = true
}

// 移动完成：清空多选 → 重拉相册列表（数量变化）与当前相册照片（来源是虚拟相册时会变少）
async function onPhotosMoved() {
  moveVisible.value = false
  exitSelectMode()
  await loadAlbums(false)
  await nextTick()
  measure()
}

// ---- 查看器操作 ----
function viewPhoto(p) {
  // 翻页（查看器已经开着）不播进入动画：图片是直接替换的，媒体层会一直保持 media-in 状态
  const reopening = !!viewer.value
  resetPan()
  rotation.value = 0
  zoom.value = 1
  // 视频状态复位
  currentTime.value = 0
  duration.value = 0
  playing.value = false
  playbackRate.value = 1
  dragging.value = false
  viewer.value = { ...p }
  mediaReady.value = reopening
  // 信息面板开着时跟着切到新照片（面板位置保持不动，只换内容）
  if (infoVisible.value) loadPhotoInfo(viewer.value)
}
// 在扁平列表中平移当前项。
// 相册是分页加载的，走到已加载范围的边界时先把相邻那段补上；补不到（真到整册头尾）
// 就在已加载范围内首尾循环 —— 与原来的循环行为一致，只是补了一次加载。
function groupIndexOfPhoto(id) {
  for (let i = 0; i < groups.value.length; i++) {
    const ps = groups.value[i].photos
    if (ps && ps.some(p => p.id === id)) return i
  }
  return -1
}
async function stepPhoto(dir) {
  if (!viewer.value) return
  const cur = viewer.value.id
  let list = allPhotos.value
  let idx = list.findIndex(p => p.id === cur)
  if (idx === -1) return
  let next = idx + dir
  if (next < 0 || next >= list.length) {
    const gi = groupIndexOfPhoto(cur)
    const want = gi + dir
    if (gi !== -1 && want >= 0 && want < groups.value.length && !groups.value[want].photos) {
      await ensureLoaded(want)
      list = allPhotos.value
      idx = list.findIndex(p => p.id === cur)
      if (idx === -1) return
      next = idx + dir
    }
  }
  if (next < 0 || next >= list.length) next = (next + list.length) % list.length
  viewPhoto(list[next])
}
function prevPhoto() { stepPhoto(-1) }
function nextPhoto() { stepPhoto(1) }
function rotate(dir) {
  if (!viewer.value) return
  // +360 再取模：往回转（dir = -1）时不会得到负角度
  rotation.value = ((rotation.value + dir * 90) % 360 + 360) % 360
}
function zoomIn() { zoom.value = Math.min(5, zoom.value + 0.25) }
function zoomOut() { zoom.value = Math.max(0.2, zoom.value - 0.25) }
function resetView() {
  resetPan()
  rotation.value = 0
  zoom.value = 1
}
function onZoomWheel(e) {
  zoom.value = Math.min(5, Math.max(0.2, zoom.value + (e.deltaY < 0 ? 0.1 : -0.1)))
}
function closeViewer() { resetPan(); viewer.value = null; infoVisible.value = false }

// ---- 照片信息面板 ----
// 字节数格式化。0 / null 返回空串，由模板统一显示「未知」——
// 不在这里返回「未知」，是为了让「大小确实为 0 字节」和「读不到」在代码里仍然可区分。
function fmtBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return ''
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(2) + ' MB'
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

async function loadPhotoInfo(p) {
  if (!p) return
  const cachedInfo = getPhotoInfo(p.id)
  if (cachedInfo) { photoInfo.value = cachedInfo; return }
  infoLoading.value = true
  photoInfo.value = null
  try {
    const res = await axios.get(`/api/album/photo/${p.id}/info`, { headers: authHeaders() })
    if (res.data && res.data.success) {
      setPhotoInfo(p.id, res.data.data)
      // 请求期间可能已经切到别的照片：只有仍是当前这张才写入，避免旧结果盖掉新面板
      if (viewer.value && viewer.value.id === p.id) photoInfo.value = res.data.data
    }
  } catch (_) {
    if (viewer.value && viewer.value.id === p.id) photoInfo.value = null
  } finally {
    if (viewer.value && viewer.value.id === p.id) infoLoading.value = false
  }
}

function toggleInfo() {
  infoVisible.value = !infoVisible.value
  if (infoVisible.value) loadPhotoInfo(viewer.value)
}

const infoSize = computed(() => {
  const i = photoInfo.value
  if (!i || !i.width || !i.height) return '未知'
  return `${i.width} × ${i.height}`
})
// 只显示十进制经纬度，不接地图（用户明确要求）。南纬/西经靠负号区分。
const infoGps = computed(() => {
  const i = photoInfo.value
  if (!i || typeof i.lat !== 'number' || typeof i.lng !== 'number') return '未知'
  return `${i.lat.toFixed(6)}, ${i.lng.toFixed(6)}`
})

// ---- 视频控制 ----
function onLoadedmetadata() {
  const v = videoEl.value
  if (!v) return
  duration.value = v.duration || 0
  currentTime.value = v.currentTime || 0
}
function onTimeupdate() {
  const v = videoEl.value
  if (!v || dragging.value) return
  currentTime.value = v.currentTime || 0
}
function togglePlay() {
  const v = videoEl.value
  if (!v) return
  if (v.paused) {
    v.play()
  } else {
    v.pause()
  }
}
function skip(sec) {
  const v = videoEl.value
  if (!v) return
  const max = v.duration || 0
  v.currentTime = Math.max(0, Math.min(max, (v.currentTime || 0) + sec))
  currentTime.value = v.currentTime || 0
}
function onSeekInput(e) {
  const v = videoEl.value
  if (!v) return
  const t = Number(e.target.value) || 0
  v.currentTime = t
  currentTime.value = t
}
function changeRate() {
  const v = videoEl.value
  if (v) v.playbackRate = playbackRate.value
}

async function saveAs(p) {
  try {
    // 触发浏览器下载（另存为）
    const resp = await axios.get(`/api/album/photo/${p.id}/save-as`, { headers: authHeaders(), responseType: 'blob' })
    const url = URL.createObjectURL(resp.data)
    const a = document.createElement('a')
    a.href = url
    a.download = p.file_name
    a.click()
    // ⚠️ 必须延迟撤销：浏览器下载是**异步**读取 blob 的，
    // 在 a.click() 之后同步 revokeObjectURL 会让下载拿到 0 字节文件。
    // 延迟量与项目内其它下载点一致（见 subwindows/setup/Setup.vue）。
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    useNotification().success('已开始另存')
  } catch (err) {
    reportError(err, { action: '另存' })
  }
}

async function deletePhoto(p) {
  if (!confirm(`确定把「${p.file_name}」移入回收站吗？（可撤销还原）`)) return
  try {
    await axios.delete(`/api/album/photo/${p.id}`, { headers: authHeaders() })
    // 记录「删除照片」撤销：undo 从回收站搬回文件+还原索引，redo 再次移入回收站。
    // 走统一入口：登记失败会给出「本次无法撤销」弱提示并留日志，
    // 不再只写 console.warn（用户看不见，等于没提示）。
    recordUndoSpec({
      key: 'album',
      type: 'photo_trash',
      label: `删除照片：${p.file_name}`,
      payload: {
        photo: { id: p.id, album_id: activeAlbum.value?.id, file_path: p.file_path, file_name: p.file_name, file_size: p.file_size, mtime: p.mtime, photo_date: p.photo_date, exif_date: p.exif_date, date_src: p.date_src }
      }
    })
    resetPan()
    viewer.value = null
    useNotification().success('已移入回收站')
    loadPhotos()
  } catch (err) {
    reportError(err, { action: '删除' })
  }
}

onMounted(async () => {
  window.addEventListener('resize', onResize)
  await loadAlbums()
  await nextTick()
  measure()
  applyFocus()
  applyPhotoFocus()
  // 扫描渐进刷新观察器：任何入口发起的扫描都边扫边刷
  startScanWatch()
})

/* ===== KeepAlive 切回：必须自己把滚动位置恢复回来 =====
 * 实测结论（Chromium 行为，不会随版本改）：
 * KeepAlive 缓存页面时，是把组件根 DOM 挪进一个「未插入文档的 div」。这一挪，
 * 浏览器会把滚动容器的 scrollTop 重置为 0、clientHeight 变 0，**而且不派发 scroll 事件**。
 *
 * 于是切回来的状态是：容器在顶部、scrollTop ref 还停在中部（没人改它）。
 * 虚拟滚动按旧位置渲染中部的分组（绝对定位在下方），视口内空无一物 ——
 * 照片越多、滚得越深，这片空白越久，要等任意一次 scroll 事件才对齐。
 * 这就是「大相册切走一会儿再切回，好久才出画面」的真正原因。
 *
 * 恢复办法：activated 时重新量一次尺寸（窗口可能在切走期间变过），再把容器滚回原位。 */
let savedScrollTop = 0

onActivated(() => {
  applyFocus()
  applyPhotoFocus()
  // KeepAlive 首次挂载也会触发 activated；startScanWatch 幂等，重复调用无害
  startScanWatch()
  // 此刻 DOM 已插回文档，但滚动位置在 0，必须等渲染完再写 scrollTop
  nextTick(() => {
    measure()
    const el = containerRef.value
    if (!el) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const top = Math.min(savedScrollTop, max)
    el.scrollTop = top
    // 同步 ref：不写的话 scroll 事件走 rAF 才更新，恢复的这一帧窗口还是旧值
    scrollTop.value = top
  })
})
watch(() => route.query.focus, applyFocus)
watch(() => route.query.photo, applyPhotoFocus)

// 被 KeepAlive 缓存时定时器要停（见 scanWatch 注释），否则切走后仍在发请求。
// 顺手记下滚动位置 —— 只能读 onScroll 维护的 ref：onDeactivated 触发时 DOM 已被移出文档，
// 那一刻 el.scrollTop 已经是 0 了，读不到真值。
onDeactivated(() => {
  savedScrollTop = scrollTop.value
  stopScanWatch()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  // 清理所有轮询定时器，避免页面切走后仍在发请求
  stopAll()
  stopScanWatch()
  // 长按手势的定时器也要清：卸载后再触发会去操作已经不存在的组件状态
  clearPressTimer()
  // 悬停预取的定时器与在途下载同理：页面走后不该再拉原图
  onCellHoverEnd()
  releasePrefetch()
  // 1-4：信息面板缓存随页面卸载清空（跨次打开本来也不复用，避免长期驻留元数据）
  clearPhotoInfo()
})
</script>

<style scoped>
/* ===== 网格窗口化虚拟滚动 =====
 * 外层以“日期分组”为窗口单元做 JS 虚拟滚动（只挂载视口附近分组），
 * 可视区内的格子数量本来就有限，故格子本身不再加 content-visibility：
 * 它会把格子拆成独立光栅层，和毛玻璃主题的 backdrop-filter 叠加时
 * 容易出现「图片清晰但显示发虚」（层按 1x 光栅化再按 DPR 放大）。 */

/* 悬停压暗遮罩：故意不用 inset-0 / bg-black/* 这组工具类——
   全局 utilities.css 里有一条「弹窗遮罩模糊」规则用 [class*="inset-0"][class*="bg-black/"]
   做匹配，会把这种内容层遮罩也当成弹窗遮罩，加上 backdrop-filter: blur(18px)，
   导致遮罩下面的照片整张被虚化（这才是「缩略图怎么调都糊」的真凶）。 */
.photo-mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background-color: transparent;
  transition: background-color 0.2s ease;
  pointer-events: none;
}
.group:hover .photo-mask {
  background-color: rgba(0, 0, 0, 0.18);
}

/* 多选态：选中格子的高亮遮罩（与「选择照片」弹窗同一套观感）。
   选择器叠到与 hover 规则同等特异度并写在后面，保证选中色不被 hover 压掉。 */
.group .photo-mask.photo-mask--sel {
  background-color: color-mix(in srgb, var(--color-info, #38bdf8) 18%, transparent);
}

/* 隐藏相册主列表滚动条（滚动能力保留） */
.album-scroll {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.album-scroll::-webkit-scrollbar {
  display: none;
  width: 0;
}

/* ===== 多选浮窗：只在竖直方向弹入（过冲回弹，与表格新增行同一曲线、方向相反） =====
   水平居中由外层 -translate-x-1/2 负责，动画只动内层 transform，避免水平位移 */
.select-float-enter-active {
  transition: opacity 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.select-float-enter-active .select-float-panel {
  transition: transform 0.24s cubic-bezier(0.34, 1.56, 0.64, 1);
}
/* 退出：沿进入方向对称返回，向下加速淡出（时长略短于进入） */
.select-float-leave-active {
  transition: opacity 0.12s cubic-bezier(0.5, 0, 0.85, 0.3);
}
.select-float-leave-active .select-float-panel {
  transition: transform 0.12s cubic-bezier(0.5, 0, 0.85, 0.3);
}
.select-float-enter-from,
.select-float-leave-to {
  opacity: 0;
}
.select-float-enter-from .select-float-panel,
.select-float-leave-to .select-float-panel {
  transform: translateY(18px);
}

.info-panel {
  flex: 0 0 auto;
  width: 0;
  overflow: hidden;
  /* 内层固定 --info-w 且右对齐：宽度动画期间文字不会逐帧重排，只是被裁切；
     可见区域从右侧往左展开，看起来就是「从右边滑出来」。 */
  display: flex;
  justify-content: flex-end;
  cursor: default;
  transition: width 0.22s cubic-bezier(0.32, 0.72, 0.24, 1);
}
.info-panel.open {
  width: var(--info-w);
}
.info-panel-inner {
  flex: 0 0 auto;
  width: var(--info-w);
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 14px 16px;
  overflow-y: auto;
  /* 侧边栏贴边，用一条左侧分隔线代替原来的整圈描边 + 投影（挤压式不需要"浮起"感） */
  border-left: 1px solid var(--av-panel-border);
  background-color: var(--av-panel-bg);
}
.info-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
}
.info-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--av-fg);
}
/* 关闭按钮必须带 .album-viewer 前缀：theme-glass.css 里那条全局 button 皮肤特异度 0,2,1，
   只写 .info-close（scoped 后 0,2,0）会被它套上边框与外发光。 */
.album-viewer .info-close {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 9999px;
  background: transparent;
  box-shadow: none;
  color: var(--av-fg);
  font-size: 12px;
  opacity: 0.6;
  cursor: pointer;
  transition: opacity 0.15s ease, background-color 0.15s ease;
}
.album-viewer .info-close:hover {
  opacity: 1;
  background: var(--av-btn-bg);
}
.info-loading {
  padding: 18px 0;
  text-align: center;
  font-size: 12px;
  color: var(--av-fg-dim);
}
.info-sec {
  margin-top: 12px;
}
.info-sec-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--av-fg);
  opacity: 0.6;
}
.info-list {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.info-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  font-size: 12px;
  line-height: 1.55;
}
.info-row dt {
  flex: 0 0 56px;
  color: var(--av-fg);
  opacity: 0.6;
}
.info-row dd {
  flex: 1 1 auto;
  margin: 0;
  color: var(--av-fg);
  /* 路径又长又没有空格，必须允许任意位置断行，否则会把面板横向撑破 */
  word-break: break-all;
}
</style>
