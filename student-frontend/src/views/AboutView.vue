<template>
  <div>
    <div class="w-full bg-surface shadow-md rounded-xl mb-6 px-5 py-3 border border-border min-h-[4.5rem] flex items-center">
      <h1 class="text-2xl font-bold text-text flex items-center gap-2"><IconGlyph name="about" /> 关于软件</h1>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- 应用信息 -->
      <div class="bg-surface shadow-md rounded-xl border border-border p-6 md:col-span-2">
        <div class="flex items-center gap-4 mb-4">
          <div class="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center overflow-hidden">
            <img src="/logo.webp" alt="logo" class="w-full h-full object-contain" />
          </div>
          <div>
            <div class="flex items-center gap-2">
              <span class="text-xl font-bold text-text">班集</span>
              <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold text-white bg-blue-500 leading-none">预览版</span>
            </div>
            <div class="text-sm text-text-muted">班级管理一站式桌面应用</div>
          </div>
        </div>
        <p class="text-text-secondary text-sm leading-relaxed">
          班集是一个面向班级日常管理的轻量化桌面应用，整合了班级管理、班费、课程表、座位安排、
          请假考勤、班级相册等常用功能，帮助班主任与班委高效完成日常事务。
        </p>

        <div class="flex flex-wrap items-center gap-3 mt-4">
          <button @click="openLicense($event, OWN_LICENSE)" class="px-4 py-2 text-sm rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
            MIT 协议
          </button>
          <button @click="dialogVersion = true" class="px-4 py-2 text-sm rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
            版本更新
          </button>
          <button @click="dialogDonate = true" class="px-4 py-2 text-sm rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
            打赏
          </button>
        </div>
      </div>

      <!-- 功能特性 -->
      <div class="bg-surface shadow-md rounded-xl border border-border p-6">
        <h2 class="font-semibold text-text mb-4">功能特性</h2>
        <ul class="space-y-3 text-sm text-text-secondary">
          <li class="flex items-center gap-2">
            <span class="text-emerald-500"><IconGlyph name="check" :size="16" /></span> 简洁的界面和操作
          </li>
          <li class="flex items-center gap-2">
            <span class="text-emerald-500"><IconGlyph name="check" :size="16" /></span> 班级管理的定制化功能
          </li>
          <li class="flex items-center gap-2">
            <span class="text-emerald-500"><IconGlyph name="check" :size="16" /></span> 智能排表算法
          </li>
          <li class="flex items-center gap-2">
            <span class="text-emerald-500"><IconGlyph name="check" :size="16" /></span> 优美简洁的主题
          </li>
          <li class="flex items-center gap-2">
            <span class="text-emerald-500"><IconGlyph name="check" :size="16" /></span> 分布计算性能优化
          </li>
        </ul>
      </div>
    </div>

    <!-- 技术栈（毛玻璃卡片） -->
    <div class="mt-6 bg-surface shadow-md rounded-xl border border-border p-6 relative">
      <h2 class="font-semibold text-text mb-4 flex items-center gap-2"><IconGlyph name="wrench" :size="20" /> 使用的开源项目</h2>
      <p class="text-xs text-text-muted mb-3 px-1 leading-relaxed">感谢所有开源提供者，本项目基于众多优秀开源项目构建，第三方组件遵循各自开源许可证；版本号为项目声明的依赖版本。点击每行右侧的许可证标签可阅读许可协议，默认显示英文原文，可切换中文说明。</p>
      <div ref="libListRef" class="max-h-64 overflow-y-auto pr-1 scroll-smooth app-custom-scroll">
        <div v-for="group in libGroups" :key="group.category" class="mb-3 last:mb-0">
          <div class="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1.5 px-1">{{ group.category }}<span v-if="group.note" class="ml-2 font-normal normal-case tracking-normal text-text-muted/60">{{ group.note }}</span></div>
          <div class="space-y-0.5">
            <a v-for="lib in group.items" :key="lib.name" :href="lib.url" target="_blank" rel="noopener"
              @click="openExternal($event, lib.url)"
              class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors no-underline group text-sm min-w-0">
              <!-- 固定宽度而非 min-w：min-w 会被「原生模块重编译」这类长用途撑开，
                   那一行的依赖名就比别行靠右。120px 放得下最长的 7 个汉字，且统一往后隔开。 -->
              <span class="text-text-secondary shrink-0 w-[7.5rem]">{{ lib.desc }}</span>
              <span class="text-text font-medium min-w-0 truncate" :title="lib.name">{{ lib.name }}</span>
              <span v-if="versionOf(lib)" class="text-[11px] font-mono text-text-muted/70 shrink-0">v{{ versionOf(lib) }}</span>
              <span class="text-[11px] text-text-muted/50 min-w-0 flex-1 truncate" :title="lib.url">{{ lib.url }}</span>
              <span role="button" tabindex="0" :title="'阅读 ' + lib.license + ' 协议全文'"
                @click="openLicense($event, lib)" @keydown.enter="openLicense($event, lib)" @keydown.space="openLicense($event, lib)"
                class="text-xs font-mono px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 text-text-muted shrink-0 cursor-pointer hover:bg-primary/15 hover:text-primary focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary">{{ lib.license }}</span>
            </a>
          </div>
        </div>
      </div>
      <!-- 开源清单：常驻滚动条；卡片 relative，覆盖层落在右侧内边距里。
           .app-custom-scroll 已把原生纵向滚动条宽度压成 0，全靠这个组件绘制；
           这里不能再开 auto-hide（平时 opacity:0），否则列表看起来就是「没有滚动条」。 -->
      <CustomScrollbar :target="libListRef" />
    </div>

    <div class="mt-6 bg-surface shadow-md rounded-xl border border-border p-6 text-center text-sm text-text-muted space-y-1.5">
      <div>本软件遵循 <a href="https://opensource.org/license/mit" target="_blank" rel="noopener" @click="openExternal($event, 'https://opensource.org/license/mit')" class="text-primary hover:underline">MIT License</a> 发布</div>
      <div class="text-text-muted/70">可自由使用、修改与分发（含商业用途）；分发时保留版权声明与许可声明即可</div>
      <div>
        Copyright &copy; 无聊的小洋葱 2026 &nbsp;|&nbsp;
        <a href="https://github.com/onion383/classnest" target="_blank" rel="noopener" @click="openExternal($event, 'https://github.com/onion383/classnest')" class="text-primary hover:underline">仓库地址</a>
      </div>
      <div class="text-text-muted/50">https://github.com/onion383/classnest</div>
    </div>

    <!-- 软件自己的 MIT 协议与第三方许可证共用下方同一个弹窗（见 OWN_LICENSE），
         不再单独维护 dialogProtocol / licenseBodyRef 那套实现。 -->
    <!-- 许可证弹窗：默认英文原文（按需懒加载），中文说明通过切换查看 -->
    <Teleport to="body">
      <Transition name="dialog">
        <div v-if="activeLicense" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" @click.self="closeLicense">
          <!-- 高度固定：英文全文/中文要点/加载态长短不一，不固定会在切换语言时整窗跳高。
               内容区已 flex-1 min-h-0 overflow-y-auto，长文本在区内滚动。 -->
          <div class="dialog-card bg-surface rounded-xl shadow-2xl border border-border w-full max-w-2xl mx-4 h-[70vh] flex flex-col relative min-w-0" @click.stop>
            <div class="flex items-center justify-between gap-3 px-6 py-4 border-b border-border shrink-0">
              <!-- 标题完整显示：复合声明（MIT / BSD-3-Clause、MPL-2.0 OR Apache-2.0）
                   必须整串可读，不能用 truncate 截成「MIT …」。用 break-words 让长名换行，
                   也避免最长那句不换行把 .dialog-card 撑宽。 -->
              <div class="min-w-0">
                <h2 class="text-lg font-semibold text-text break-words">{{ activeLicense.lib.name }} 许可协议</h2>
                <div class="text-xs text-text-muted mt-0.5 break-words">{{ activeLicense.title }}协议</div>
              </div>
              <button @click="closeLicense" class="dlg-close shrink-0">&times;</button>
            </div>
            <!-- 语言切换：默认英文；「具有法律效力 / 仅供参考」由标签本身承担，不再叠常驻免责条。
                 中性配色（bg-primary/15 + text-primary）避开四套主题对实心按钮的不同规则。 -->
            <div class="px-6 py-2.5 border-b border-border shrink-0 flex items-center gap-1" role="tablist" aria-label="许可证语言">
              <button type="button" role="tab" class="lang-tab" :aria-selected="licenseLang === 'en'" @click="licenseLang = 'en'"
                :class="['h-8 px-3 rounded-lg text-xs transition-colors', licenseLang === 'en' ? 'bg-primary/15 text-primary font-medium' : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-text']">英文版本 具有法律效力</button>
              <button type="button" role="tab" class="lang-tab" :aria-selected="licenseLang === 'zh'" @click="licenseLang = 'zh'"
                :class="['h-8 px-3 rounded-lg text-xs transition-colors', licenseLang === 'zh' ? 'bg-primary/15 text-primary font-medium' : 'text-text-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-text']">中文摘要 仅供参考</button>
            </div>
            <!-- 协议正文统一 14px（text-sm）；加载态 / 错误 / 口径说明（note）
                 属于辅助信息，仍保留小一号 text-xs。 -->
            <div ref="licenseDocRef" class="flex-1 min-h-0 overflow-y-auto px-6 py-4 text-sm text-text-secondary leading-relaxed app-custom-scroll">
              <div v-for="(sec, i) in activeLicense.sections" :key="i" class="mb-6 last:mb-0 min-w-0">
                <!-- 内容区内部的许可证文件标题：用完整名称而非 token（MIT → MIT License），
                     break-words 保证长名换行、绝不截断；放在语言分支之外，
                     加载中 / 加载失败 / 未收录全文时也有标题。
                     不加粗、用正文同色（text-sm + text-text-secondary），避免抢正文的视觉层级。
                     例外：软件自己的 LICENSE.md 首行本来就写着标题，英文版再补一层会叠成两行 →
                     让位给文件自带那行，全文一个字都不动；中文版不是全文（要点分块），仍需这层标题。
                     第三方收录的 MIT.txt 首行是版权声明、没有标题行，因此第三方一律常显。 -->
                <h3 v-if="!activeLicense.lib.own || licenseLang === 'zh'" class="text-sm text-text-secondary mb-3 break-words">{{ sec.fullName }}</h3>
                <!-- 中文版：按英文原文的条款顺序分块组织的要点说明（非官方译本、不逐句直译）。
                     块标签是不加粗的小字辅助色，正文与英文版同为 14px；分块结构让中英可对照。 -->
                <template v-if="licenseLang === 'zh'">
                  <!-- 版权行对齐英文全文第一行：独立置顶、不加粗、正文同色；只在中文版出现，
                       英文版原文第一行本来就有 Copyright。年份与名字照抄原文，不翻译。 -->
                  <div v-if="sec.copyright" class="text-sm text-text-secondary mb-4 break-words">{{ sec.copyright }}</div>
                  <div v-if="sec.zh && sec.zh.length" class="space-y-3">
                    <div v-for="(clause, ci) in sec.zh" :key="ci" class="min-w-0">
                      <div class="text-xs text-text-muted mb-1 break-words">{{ clause.label }}</div>
                      <p class="text-sm leading-relaxed text-text-secondary">{{ clause.text }}</p>
                    </div>
                  </div>
                  <p v-else class="text-xs text-text-muted">该许可证暂无中文说明，请以英文原文为准。</p>
                </template>
                <!-- 英文版：唯一具有法律效力的文本，首次点开弹窗时才加载 -->
                <template v-else>
                  <div v-if="licenseLoading" class="text-xs text-text-muted py-2">正在加载英文原文…</div>
                  <div v-else-if="licenseError" class="text-xs text-red-500 py-2">{{ licenseError }}</div>
                  <pre v-else-if="sec.text" :class="['whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-text-secondary', { 'license-own-pre': activeLicense.lib.own }]">{{ sec.text }}</pre>
                  <div v-else class="text-xs text-text-muted py-2">本项目未收录该许可证全文，请以下方官方页面的英文条款为准。</div>
                </template>
                <p v-if="sec.note" class="mt-3 text-xs text-text-muted">{{ sec.note }}</p>
                <a v-if="sec.url" :href="sec.url" target="_blank" rel="noopener" @click="openExternal($event, sec.url)"
                  class="text-primary hover:underline text-sm break-all mt-2 block">{{ sec.url }}</a>
              </div>
            </div>
            <CustomScrollbar :target="licenseDocRef" />
            <div class="px-6 py-4 border-t border-border shrink-0 flex justify-end">
              <button @click="closeLicense" class="px-4 py-2 rounded-lg bg-primary text-text-inverse text-sm">关闭</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 版本更新弹窗 -->
    <Teleport to="body">
      <Transition name="dialog">
        <div v-if="dialogVersion" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" @click.self="dialogVersion = false">
          <!-- 高度上限：70vh 仍偏高（上下几乎不留白），再降到 60vh。
               上半信息块 shrink-0 不动，下半更新历史区 flex-1 min-h-0 自动收缩并内部滚动。 -->
          <div class="dialog-card bg-surface rounded-xl shadow-2xl border border-border w-full max-w-md mx-4 relative flex flex-col max-h-[60vh]" @click.stop>
          <button @click="dialogVersion = false" class="dlg-close absolute! top-3 right-3">&times;</button>

          <!-- 上半部分：居中信息 -->
          <div class="px-6 pt-8 pb-4 text-center shrink-0">
            <img src="/logo.webp" alt="logo" class="w-16 h-16 mx-auto object-contain" />
            <div class="mt-4 flex items-center justify-center gap-2">
              <span class="text-base font-semibold text-text">v{{ currentVersion || '0.1.0' }}</span>
              <span class="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold text-white bg-blue-500 leading-none">预览版</span>
              <button @click="checkUpdate" :disabled="updateBusy" class="px-3 py-1 rounded-full bg-primary/10 text-primary text-xs hover:bg-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">检查更新</button>
            </div>
            <div class="mt-3 text-xs text-text-muted">开源许可：MIT</div>
            <div class="mt-1 text-xs text-text-muted">Copyright &copy; 无聊的小洋葱 2026</div>

            <!-- 更新状态与下载进度 -->
            <div class="mt-3 text-xs font-medium" :class="statusClass">{{ statusText }}</div>
            <div v-if="updateStatus === 'downloading'" class="mt-2">
              <div class="h-1.5 rounded-full bg-bg border border-border overflow-hidden">
                <div class="h-full rounded-full bg-primary transition-[width] duration-300" :style="{ width: updatePercent + '%' }"></div>
              </div>
            </div>
            <button v-if="updateStatus === 'downloaded'" @click="installUpdate" class="mt-3 px-4 py-2 rounded-lg bg-primary text-text-inverse text-sm">重启并安装</button>
          </div>

          <!-- 下半部分：更新历史（可滚动文本框） -->
          <div class="px-6 pb-6 flex-1 min-h-0 flex flex-col">
            <div class="text-sm font-semibold text-text mb-2">更新历史</div>
            <!-- 细滑块与列表同处一个 relative 父级：否则 right:0 会贴到弹窗卡片右缘，
                 而不是这个带边框的列表框内侧。 -->
            <div class="relative flex-1 min-h-0 flex flex-col">
              <div ref="changelogListRef" class="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border bg-bg p-3 space-y-3 text-sm app-custom-scroll">
                <div v-for="c in changelog" :key="c.version">
                  <div class="flex items-baseline gap-2">
                    <span class="text-text font-medium">v{{ c.version }}</span>
                    <span class="text-xs text-text-muted">{{ c.date }}</span>
                  </div>
                  <ul class="mt-1 pl-5 list-disc space-y-0.5 text-text-secondary">
                    <li v-for="(n, i) in c.notes" :key="i">{{ n }}</li>
                  </ul>
                </div>
              </div>
              <CustomScrollbar :target="changelogListRef" compact :arrows="false" auto-hide :min-thumb="22" />
            </div>
          </div>
        </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 打赏弹窗 -->
    <Teleport to="body">
      <Transition name="dialog">
        <div v-if="dialogDonate" class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" @click.self="dialogDonate = false">
          <div class="dialog-card bg-surface rounded-xl shadow-2xl border border-border w-full max-w-md mx-4" @click.stop>
          <div class="flex items-center justify-between px-6 py-4 border-b border-border">
            <h2 class="text-lg font-semibold text-text">打赏</h2>
            <button @click="dialogDonate = false" class="dlg-close">&times;</button>
          </div>
          <div class="px-6 py-4 text-sm text-text-secondary text-center">
            <p class="mb-4">本软件开源免费，如果你觉得好的话欢迎打赏我们</p>
            <div class="grid grid-cols-2 gap-4">
              <div class="space-y-2">
                <div class="text-text font-medium">微信</div>
                <img src="/wechatpay.webp" alt="微信收款码" class="w-full h-auto rounded-lg border border-border" />
              </div>
              <div class="space-y-2">
                <div class="text-text font-medium">支付宝</div>
                <img src="/alipay.webp" alt="支付宝收款码" class="w-full h-auto rounded-lg border border-border" />
              </div>
            </div>
          </div>
          <div class="px-6 py-4 border-t border-border flex justify-end">
            <button @click="dialogDonate = false" class="px-4 py-2 rounded-lg bg-primary text-text-inverse text-sm">确定</button>
          </div>
        </div>
      </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup vapor>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { SEND, INVOKE, RECEIVE } from '../electronChannels.js'
import CustomScrollbar from '../components/base/CustomScrollbar.vue'
// 协议全文直接引用仓库根 LICENSE.md，避免正文出现两份
import licenseText from '../../../LICENSE.md?raw'
// 第三方许可证英文原文改成按需加载：见 utils/licenseDocs.js（首次点开弹窗时才 import）。
// 这里只保留轻量的中文要点说明，不再把 6 份全文静态塞进关于页 chunk。
import { createLatest } from '../utils/latestOnly.js'
import { useDisposables } from '../utils/disposables.js'
// 依赖版本号不写死：三份 package.json 是声明版本的唯一来源，FFmpeg 版本取自随包构建信息。
// 升级依赖后关于页自动跟随，不需要再手工同步一份数字（?raw 在构建时内联，不依赖运行时读文件）。
import pkgRoot from '../../../package.json'
import pkgFrontend from '../../package.json'
import pkgBackend from '../../../student-backend/package.json'
import ffmpegBuildInfo from '../../../resources/ffmpeg/BUILD-INFO.txt?raw'
// harfbuzzjs 的 wasm 直接随包复制、没有 npm 声明；版本取自子集引擎的来源注释（与 FFmpeg 同构，不写死数字）
import hbSubsetSource from '../utils/hbSubset.js?raw'
// 更新历史同样只维护一份：仓库根 CHANGELOG.md，这里只负责解析
import changelogSource from '../../../CHANGELOG.md?raw'
import { parseChangelog } from '../utils/changelog.js'
import '../styles/dialog-transition.css'

// Electron 内用系统浏览器打开外链，非 Electron 环境让浏览器默认行为处理
function openExternal(event, url) {
  if (window.electron && window.electron.invoke) {
    event.preventDefault()
    window.electron.invoke(INVOKE.OPEN_EXTERNAL, url)
  }
  // 非 Electron：不阻止默认行为，让 href 直接在新标签页打开
}

// 弹窗状态（软件自己的 MIT 协议已并入许可证弹窗，不再单独维护 dialogProtocol）
const dialogVersion = ref(false)
const dialogDonate = ref(false)

// 列表 / 弹窗的滚动容器（自定义滚动条的目标）
const libListRef = ref(null)
const changelogListRef = ref(null)
const licenseDocRef = ref(null)

// ---- 许可证弹窗（英文原文懒加载 + 中文要点按需切换）----
// FSF 明确不批准任何译文为正式有效版本，只有英文原文能界定分发条款。
// 中文内容只是帮助理解的要点概括；「仅供参考 / 具有法律效力」由切换标签承担，正文不再叠免责条。
// 每次打开都重置为英文，避免上次切到中文后下次打开先看到非权威文本。
const licenseLang = ref('en')

// 内部标题 = 许可证的正式完整名称（法律文本名称，不翻译、不简写、不截断）。
// 与 sec.title（token，用于查 LICENSE_TEXTS 全文）分开：查表键必须保持 token 不变。
// 新增许可证类型时补一行即可，未收录时回退成 token，至少不会空白。
const LICENSE_FULL_NAMES = {
  'MIT': 'MIT License',
  'ISC': 'ISC License',
  'Apache-2.0': 'Apache License, Version 2.0',
  'BSD-2-Clause': 'BSD 2-Clause License',
  'BSD-3-Clause': 'BSD 3-Clause License',
  'LGPL-2.1-or-later': 'GNU Lesser General Public License, Version 2.1',
  'SIL OFL 1.1': 'SIL Open Font License, Version 1.1',
  'Pixabay Content License': 'Pixabay Content License',
}

// 中文版按英文原文的条款顺序分块（授权 → 条件 → 免责 → 附注），便于中英对照。
// 仍是帮助理解的要点说明、非官方译本，不逐句直译；「仅供参考」由切换标签承担。
// 每项为 [{ label, text }] 数组；改结构必须同步改模板里的 v-for 渲染。
const LICENSE_ZH = {
  'MIT': [
    { label: '授权范围', text: '允许任何人免费使用、复制、修改、合并、发布、分发、再授权和销售软件及其副本（含商业用途）。' },
    { label: '唯一条件', text: '在软件的所有副本或主要部分中保留版权声明与本许可声明。' },
    { label: '无担保与责任限制', text: '软件按「现状」提供，不作任何明示或默示担保；作者与版权持有人对任何索赔、损害或其他责任概不负责。' },
  ],
  'ISC': [
    { label: '授权范围', text: '允许为任何目的（收费或免费均可）使用、复制、修改和/或分发软件。' },
    { label: '条件', text: '所有副本保留版权声明与本许可声明。' },
    { label: '无担保与责任限制', text: '软件按「现状」提供，作者免除一切明示或默示担保，并对任何特殊、直接、间接或后果性损害免责。' },
    { label: '收录说明', text: '本项目收录的这份全文末尾另附有源自 Feather 项目的图标清单及其 MIT 许可，须一并保留。' },
  ],
  'Apache-2.0': [
    { label: '授权范围', text: '宽松许可：允许商业使用、修改、分发与再授权，并附带明确的专利授权。' },
    { label: '专利授权终止', text: '若你主动就该作品提起专利侵权诉讼，授予你的专利许可自起诉之日起终止。' },
    { label: '分发条件', text: '分发时须随附许可证副本、标注被修改的文件、保留原版权/专利/商标/归属声明，并按规则保留 NOTICE 文件中的归属声明。' },
    { label: '商标、贡献与责任', text: '不授予许可方的商标、商品名或服务标识使用权；贡献默认按本许可证授权；作品按「现状」提供且责任受限。' },
  ],
  'BSD-2-Clause': [
    { label: '授权范围', text: '允许以源码或二进制形式使用与再分发（可修改，含商业用途）。' },
    { label: '两个条件', text: '源码分发保留版权声明、条件清单与免责声明；二进制分发须在随附文档或其他材料中复制上述内容。' },
    { label: '责任限制', text: '软件按「现状」提供，版权持有人与贡献者不对任何直接、间接、附带、特殊、惩戒性或后果性损害负责。' },
  ],
  'BSD-3-Clause': [
    { label: '授权范围', text: '允许以源码或二进制形式使用与再分发（可修改，含商业用途）。' },
    { label: '三个条件', text: '源码分发保留版权声明、条件清单与免责声明；二进制分发须在随附文档或其他材料中复制上述内容；未经事先书面许可，不得使用作者姓名为源自本软件的衍生产品背书或推广。' },
    { label: '责任限制', text: '软件按「现状」提供，作者对任何直接、间接、附带、特殊、惩戒性或后果性损害免责。' },
  ],
  'LGPL-2.1-or-later': [
    { label: '许可性质', text: '面向函数库的弱 copyleft 许可。' },
    { label: '使用与衍生作品', text: '允许专有软件通过链接或调用方式使用该库而无需开源自身代码；但若修改了库本身或基于库创作衍生作品，这些修改与衍生部分须按 LGPL 提供。' },
    { label: '分发条件', text: '分发时须随附本许可证副本与版权声明、提供库源码或等价获取途径，并允许用户为调试修改而进行反向工程。' },
    { label: '无担保与本项目说明', text: '无担保。本项目随附的是 LGPL 版 FFmpeg 构建。' },
  ],
  'SIL OFL 1.1': [
    { label: '授权范围', text: '字体专用许可的要点概括：允许自由使用、研究、修改和再分发字体（含商业用途、可嵌入文档与 PDF）。' },
    { label: '禁止事项', text: '不得单独出售字体本身；修改版不得使用保留字体名（Reserved Font Name，除非另行获授权）。' },
    { label: '衍生字体条件', text: '衍生字体须同样以 OFL 发布且不得附加限制，并须随字体附带版权声明与本许可全文。' },
    { label: '免责与收录说明', text: '字体按「现状」提供。本项目已收录英文全文，可切换到英文版本查阅完整条款。' },
  ],
  'Pixabay Content License': [
    { label: '授权范围', text: '素材内容许可的要点概括：允许免费下载与使用图片等内容（含商业用途），可修改，通常无需署名。' },
    { label: '禁止事项', text: '不得原样转售或单独分发素材本身，不得把可识别人物用于负面或敏感语境，也不得用于商标、标识等用途。' },
    { label: '以英文原文为准', text: '具体允许与禁止情形以 Pixabay 服务条款第 5 节「Content License granted to you for Content」的英文原文为准；本项目未收录全文。' },
  ],
}

// 中文版顶部的版权行，对齐英文全文第一行。只把 Copyright 译成「版权所有」，
// 年份与版权人名字一律照抄收录全文（许可证要求版权声明原样保留，不翻译人名/年份）。
// 通用条款或仓库未收录全文的，只写「以英文原文为准」，不编造版权人。
const LICENSE_COPYRIGHT = {
  'MIT': '版权所有 (c) 2014-present Matt Zabriskie & Collaborators',
  'ISC': '版权所有 (c) 2026 Lucide Icons and Contributors',
  'Apache-2.0': '版权归各贡献者所有；以英文原文中的版权声明为准',
  'BSD-2-Clause': '版权所有 (c) 2013, Michael Williamson',
  'BSD-3-Clause': '版权所有 (c) 2012 Nevins Bartolomeo、(c) 2012 Shane Girish、(c) 2025 Daniel Wirtz',
  'LGPL-2.1-or-later': '版权所有 (C) 1991, 1999 Free Software Foundation, Inc.',
  // OFL 正文没有单一版权人（只有 Copyright Holder(s) 定义），具体声明在字体文件 name 表内。
  'SIL OFL 1.1': '字体版权归各字体作者所有；具体声明见字体文件 name 表',
  'Pixabay Content License': '素材版权归各上传者所有；以 Pixabay 服务条款英文原文为准',
}
// 软件自己的版权行取自根 LICENSE.md；它与第三方 MIT 共用中文分块说明，但版权人不同，必须单独覆盖。
const OWN_COPYRIGHT = '版权所有 (c) 2026 无聊的小洋葱'

// 仓库未收录全文的一项（Pixabay）：弹窗里说明口径并给出官方原文地址（不手写许可正文）。
// OFL 全文已收录进 SIL-OFL-1.1.txt，这里只保留官方来源链接与随包分发提醒。
const EXTERNAL_LICENSES = {
  'SIL OFL 1.1': {
    note: '英文全文取自 SIL 官网 OFL.txt；分发字体时仍须随附许可与版权声明，字体文件 name 表内已含许可声明。',
    url: 'https://openfontlicense.org/open-font-license-official-text/',
  },
  'Pixabay Content License': {
    note: '仓库未收录全文；授权条款见 Pixabay 服务条款第 5 节。',
    url: 'https://pixabay.com/service/terms/',
  },
}

// 软件自己的 MIT 协议也走同一个弹窗：全文唯一来源仍是仓库根 LICENSE.md（静态引入），
// 不复制进 licenseDocs.js，也不触发 43KB 懒加载；中文要点与第三方 MIT 共用同一份分块说明。
const OWN_LICENSE = Object.freeze({
  name: '班集',
  license: 'MIT',
  url: '',
  own: true,
})

const activeLicense = ref(null)
const licenseLoading = ref(false)
const licenseError = ref('')
// 全库唯一的序号守卫：连点不同协议时，只让最后一次加载写状态。
const licenseLatest = createLatest()
const d = useDisposables()
// 用 defer() 而不是 timeout()：timeout() 返回的「取消函数」只把清理项从登记表摘掉，
// 并不 clearTimeout（实测调用后回调仍会触发），会在加载成功 8 秒后把全文覆盖成错误提示。
// defer() 每次排期自动清掉上一次，.cancel() 也会真的清掉 timer，且随作用域释放。
const loadTimeout = d.defer()

// 英文原文按需 import；import() 自带模块缓存，不需要自己再存一份 Promise。
async function loadLicenseTexts(token) {
  // 软件自己的协议全文已静态注入；误走懒加载会用第三方 MIT.txt 覆盖掉本软件的版权行。
  if (activeLicense.value?.lib.own) return
  licenseLoading.value = true
  licenseError.value = ''
  // 兜底：chunk 加载异常挂起时不让弹窗一直转圈；加载成功后必须真正清掉它。
  // defer 的 schedule 会自动取消上一次仍在排期的定时器，不必手动先 cancel。
  loadTimeout(() => {
    if (!licenseLatest.isCurrent(token) || !activeLicense.value) return
    licenseLoading.value = false
    licenseError.value = '英文原文加载超时，请关闭后重试'
  }, 8000)
  try {
    const { LICENSE_TEXTS } = await import('../utils/licenseDocs.js')
    // await 之后、写状态之前必判：快速连点或中途关窗都不能让旧结果覆盖当前弹窗。
    if (!licenseLatest.isCurrent(token) || !activeLicense.value) return
    // 整体替换而非逐字段赋值：确保 Vapor 模板一定能观察到 sections 变化。
    activeLicense.value = {
      ...activeLicense.value,
      sections: activeLicense.value.sections.map(s => ({ ...s, text: LICENSE_TEXTS[s.title] || '' })),
    }
  } catch (e) {
    if (!licenseLatest.isCurrent(token)) return
    licenseError.value = '英文原文加载失败，请关闭后重试'
    console.error(e)
  } finally {
    // 只让最新一次加载收尾：快速连点时，旧加载的 finally 不能清掉新加载的兜底定时器。
    if (licenseLatest.isCurrent(token)) {
      licenseLoading.value = false
      loadTimeout.cancel()
    }
  }
}

function openLicense(event, lib) {
  // 标签在整行 <a> 内部：必须同时掐断默认跳转与冒泡，否则点协议会把项目仓库也打开。
  if (event) {
    event.preventDefault()
    event.stopPropagation()
  }
  const token = licenseLatest.begin()
  licenseLang.value = 'en'
  // dompurify 声明为 MPL-2.0 OR Apache-2.0；licenses.md 第 4 节明确本项目未改源码、按 Apache-2.0 分支使用。
  const tokens = lib.license === 'MPL-2.0 OR Apache-2.0'
    ? ['Apache-2.0']
    : lib.license.split(/\s+(?:\/|OR)\s+/).map(s => s.trim())
  const sections = tokens.map((tokenName) => {
    const external = EXTERNAL_LICENSES[tokenName]
    const zh = LICENSE_ZH[tokenName] || []
    // 中文分块是数组，空数组也是 truthy：判断「有没有中文」必须用 length，
    // 否则未收录类型的 note / url 兜底会被空数组骗过去，弹窗既无说明也无官方链接。
    const hasZh = zh.length > 0
    return {
      title: tokenName,
      fullName: LICENSE_FULL_NAMES[tokenName] || tokenName,
      copyright: lib.own ? OWN_COPYRIGHT : (LICENSE_COPYRIGHT[tokenName] || ''),
      zh,
      // 软件自己的协议全文静态可用，直接注入；第三方仍由 loadLicenseTexts 异步填入。
      text: lib.own ? licenseText : '',
      // 兜底：以后新增未收录的类型也不会弹一个空白窗，至少给出项目仓库地址。
      note: external?.note || (lib.license === 'MPL-2.0 OR Apache-2.0'
        ? 'dompurify 声明为 MPL-2.0 OR Apache-2.0；本项目未修改其源码，按 Apache-2.0 分支使用。'
        : (hasZh ? '' : '仓库未收录该许可证全文，请查阅该项目的官方仓库。')),
      url: external?.url || (hasZh ? '' : lib.url),
    }
  })
  // title 取原始完整声明（含 / 与 OR），不简写成实际展示的那一节，标题要如实反映该依赖的许可。
  activeLicense.value = { lib, title: lib.license, sections }
  if (lib.own) {
    // 全文已静态注入：不懒加载；顺手撤掉上一次可能仍在排期的 8 秒兜底定时器，
    // 否则它会把自己的协议也判成「加载超时」。
    loadTimeout.cancel()
    licenseLoading.value = false
    licenseError.value = ''
    return
  }
  // 不 await：事件处理器保持同步；加载态由弹窗自己显示。
  loadLicenseTexts(token)
}

// 关闭 ≠ 卸载：内容被 v-if 掉时组件仍在，必须主动作废在途加载与兜底定时器。
function closeLicense() {
  licenseLatest.invalidate()
  loadTimeout.cancel()
  licenseLang.value = 'en'
  activeLicense.value = null
  licenseLoading.value = false
  licenseError.value = ''
}

// ---- 版本更新 ----
// 状态由主进程作为唯一权威来源，通过 from-main{type:'update-state'} 广播；
// 这里只做展示：打开弹窗时主动查一次，并订阅后续变化（下载进度等）。
const currentVersion = ref('')
const latestVersion = ref('')
const updateStatus = ref('idle') // idle | checking | available | downloading | downloaded | not-available | error
const updatePercent = ref(0)
const updateError = ref('')
let updateListener = null

const statusText = computed(() => {
  switch (updateStatus.value) {
    case 'checking': return '正在检查…'
    case 'available': return latestVersion.value ? `发现新版本 v${latestVersion.value}，正在下载…` : '发现新版本，正在下载…'
    case 'downloading': return `正在下载 ${updatePercent.value}%`
    case 'downloaded': return '新版本已下载，重启即可安装'
    case 'not-available': return '已经是最新版本'
    case 'error': return updateError.value ? `更新失败：${updateError.value}` : '更新失败'
    default: return '等待检查'
  }
})
const statusClass = computed(() => {
  if (updateStatus.value === 'downloaded' || updateStatus.value === 'not-available') return 'text-emerald-500'
  if (updateStatus.value === 'error') return 'text-red-500'
  return 'text-primary'
})
// 检查/下载进行中：禁用「检查更新」按钮，避免重复触发
const updateBusy = computed(() => ['checking', 'available', 'downloading'].includes(updateStatus.value))

// 更新历史：唯一来源是仓库根 CHANGELOG.md，发版时只改那一份文件。
// 解析器按日期倒序输出，写文件时无需手动保证顺序。
const changelog = parseChangelog(changelogSource)

function applyUpdateState(s) {
  if (!s) return
  updateStatus.value = s.status || 'idle'
  if (s.currentVersion) currentVersion.value = s.currentVersion
  if (s.latestVersion) latestVersion.value = s.latestVersion
  updatePercent.value = typeof s.percent === 'number' ? s.percent : 0
  updateError.value = s.error || ''
}

async function fetchAppVersion() {
  try {
    const v = await window.electron?.invoke(INVOKE.GET_APP_VERSION)
    if (v) currentVersion.value = v
  } catch (_) { /* 非 Electron 环境忽略 */ }
}

async function checkUpdate() {
  try {
    const s = await window.electron?.invoke(INVOKE.UPDATE_CHECK)
    applyUpdateState(s)
  } catch (e) {
    // 原来静默吞掉：用户点了「检查更新」后界面毫无变化，分不清「已是最新」还是「检查失败」。
    // ⚠️ 必须同时置 updateStatus='error'：statusText 只在 status==='error' 分支里读 updateError，
    // 只设 updateError 而不改状态的话，那段文案永远不会显示（界面停在「等待检查」）。
    updateError.value = '检查更新失败，请检查网络后重试'
    updateStatus.value = 'error'
    console.error(e)
  }
}

function installUpdate() {
  window.electron?.send(SEND.UPDATE_INSTALL)
}

onMounted(() => {
  fetchAppVersion()
  updateListener = window.electron?.on(RECEIVE.FROM_MAIN, (data) => {
    if (data && data.type === 'update-state') applyUpdateState(data.state)
  })
})

onUnmounted(() => {
  if (updateListener) window.electron?.off(RECEIVE.FROM_MAIN, updateListener)
  // 卸载后不许再有任何在途加载写回状态（disposables 会自行清掉兜底定时器）
  licenseLatest.invalidate()
})

// 打开弹窗时刷新一次版本号并触发检查
watch(dialogVersion, (open) => {
  if (open) {
    fetchAppVersion()
    checkUpdate()
  }
})

// 显示名与 npm 包名不一致的少数几项；其余按显示名小写直接查表。
const PKG_ALIAS = {
  'Vue 3': 'vue',
  'Vue Router': 'vue-router',
  'Tailwind CSS': 'tailwindcss',
  'SheetJS (xlsx)': 'xlsx',
}

const declaredVersions = (() => {
  const out = {}
  const collect = (deps) => {
    for (const [name, range] of Object.entries(deps || {})) {
      const raw = String(range)
      // xlsx 来自 SheetJS CDN 的 tarball，没有 ^x.y.z 形式的声明，从文件名取版本号
      const tarball = raw.match(/xlsx-(\d+\.\d+\.\d+)\.tgz/)
      out[name] = tarball ? tarball[1] : raw.replace(/^[\^~><=\s]*/, '')
    }
  }
  for (const pkg of [pkgRoot, pkgFrontend, pkgBackend]) {
    collect(pkg.dependencies)
    collect(pkg.devDependencies)
  }
  return out
})()

// FFmpeg 不是 npm 包，版本写在随包 BUILD-INFO.txt 里（只读，不改动资源目录）
const ffmpegVersion = ffmpegBuildInfo.match(/FFmpeg\s+(\d+(?:\.\d+)+)/)?.[1] || ''
// wasm 版本记在 hbSubset.js 的来源注释里：升级 wasm 时改那一处，关于页自动跟随
const harfbuzzVersion = hbSubsetSource.match(/harfbuzzjs\s+(\d+(?:\.\d+)+)/)?.[1] || ''

function versionOf(lib) {
  if (lib.name.startsWith('FFmpeg')) return ffmpegVersion
  if (lib.name === 'harfbuzzjs') return harfbuzzVersion
  return declaredVersions[PKG_ALIAS[lib.name] || lib.name.toLowerCase()] || ''
}

const libGroups = [
  {
    category: '桌面壳',
    items: [
      { desc: '桌面框架', name: 'Electron', url: 'https://github.com/electron/electron', license: 'MIT' },
      { desc: '应用打包', name: 'electron-builder', url: 'https://github.com/electron-userland/electron-builder', license: 'MIT' },
      { desc: '原生 FFI', name: 'koffi', url: 'https://github.com/Koromix/koffi', license: 'MIT' },
    ],
  },
  {
    category: '前端',
    items: [
      { desc: '前端框架', name: 'Vue 3', url: 'https://github.com/vuejs/core', license: 'MIT' },
      { desc: '前端路由', name: 'Vue Router', url: 'https://github.com/vuejs/router', license: 'MIT' },
      { desc: '状态管理', name: 'Pinia', url: 'https://github.com/vuejs/pinia', license: 'MIT' },
      { desc: '构建工具', name: 'Vite', url: 'https://github.com/vitejs/vite', license: 'MIT' },
      { desc: 'CSS 框架', name: 'Tailwind CSS', url: 'https://github.com/tailwindlabs/tailwindcss', license: 'MIT' },
      { desc: 'HTTP 请求', name: 'Axios', url: 'https://github.com/axios/axios', license: 'MIT' },
      { desc: '图标库', name: '@lucide/vue', url: 'https://github.com/lucide-icons/lucide', license: 'ISC' },
      { desc: 'XSS 过滤', name: 'DOMPurify', url: 'https://github.com/cure53/DOMPurify', license: 'MPL-2.0 OR Apache-2.0' },
      { desc: 'Markdown 解析', name: 'marked', url: 'https://github.com/markedjs/marked', license: 'MIT / BSD-3-Clause' },
      { desc: 'DevTools 接口', name: '@vue/devtools-api', url: 'https://github.com/vuejs/devtools', license: 'MIT' },
      { desc: 'Vue 编译插件', name: '@vitejs/plugin-vue', url: 'https://github.com/vitejs/vite-plugin-vue', license: 'MIT' },
      { desc: 'Tailwind 插件', name: '@tailwindcss/vite', url: 'https://github.com/tailwindlabs/tailwindcss', license: 'MIT' },
    ],
  },
  {
    category: '后端',
    items: [
      { desc: '后端框架', name: 'Express', url: 'https://github.com/expressjs/express', license: 'MIT' },
      { desc: '加密数据库', name: 'better-sqlite3-multiple-ciphers', url: 'https://github.com/m4heshd/better-sqlite3-multiple-ciphers', license: 'MIT' },
      { desc: '图片处理', name: 'Sharp', url: 'https://github.com/lovell/sharp', license: 'Apache-2.0' },
      { desc: '跨域支持', name: 'cors', url: 'https://github.com/expressjs/cors', license: 'MIT' },
      { desc: '文件上传', name: 'Multer', url: 'https://github.com/expressjs/multer', license: 'MIT' },
      { desc: '视频抽帧', name: 'FFmpeg（LGPL 构建）', url: 'https://ffmpeg.org', license: 'LGPL-2.1-or-later' },
      { desc: 'ZIP 解压', name: 'yauzl', url: 'https://github.com/thejoshwolfe/yauzl', license: 'MIT' },
      { desc: 'Word 转换', name: 'Mammoth', url: 'https://github.com/mwilliamson/mammoth.js', license: 'BSD-2-Clause' },
      { desc: 'PDF 解析', name: 'pdf-parse', url: 'https://github.com/mehmet-kozan/pdf-parse', license: 'Apache-2.0' },
    ],
  },
  {
    category: '安全支持',
    items: [
      { desc: 'JWT 鉴权', name: 'jsonwebtoken', url: 'https://github.com/auth0/node-jsonwebtoken', license: 'MIT' },
      { desc: '密码加密', name: 'bcryptjs', url: 'https://github.com/dcodeIO/bcrypt.js', license: 'BSD-3-Clause' },
    ],
  },
  {
    category: '数据处理',
    items: [
      { desc: '表格导出', name: 'ExcelJS', url: 'https://github.com/exceljs/exceljs', license: 'MIT' },
      { desc: '电子表格', name: 'SheetJS (xlsx)', url: 'https://git.sheetjs.com/SheetJS/sheetjs', license: 'Apache-2.0' },
      { desc: 'PDF 生成', name: 'jsPDF', url: 'https://github.com/parallax/jsPDF', license: 'MIT' },
      { desc: 'PDF 表格', name: 'jsPDF-AutoTable', url: 'https://github.com/simonbengtsson/jsPDF-AutoTable', license: 'MIT' },
      { desc: '截图渲染', name: 'html2canvas', url: 'https://github.com/niklasvh/html2canvas', license: 'MIT' },
      { desc: '拖拽排序', name: 'SortableJS', url: 'https://github.com/SortableJS/Sortable', license: 'MIT' },
      { desc: '拼音匹配', name: 'pinyin-match', url: 'https://github.com/xmflswood/pinyin-match', license: 'MIT' },
    ],
  },
  {
    category: '开发工具',
    items: [
      { desc: '并行启动', name: 'concurrently', url: 'https://github.com/open-cli-tools/concurrently', license: 'MIT' },
      { desc: '端口就绪等待', name: 'wait-on', url: 'https://github.com/jeffbski/wait-on', license: 'MIT' },
      { desc: '原生模块重编译', name: '@electron/rebuild', url: 'https://github.com/electron/rebuild', license: 'MIT' },
    ],
  },
  {
    category: '素材资源',
    // 两张内置底图不同源：日间是 Pixabay 素材，夜间是本项目 AI 生成，不能都归到 Pixabay 名下。
    note: '日间底图来自 Pixabay；夜间底图由 AI 生成',
    items: [
      { desc: '日间背景图', name: 'Pixabay', url: 'https://pixabay.com/photos/landscape-nature-beach-sky-clouds-1973852/', license: 'Pixabay Content License' },
      { desc: 'PDF 中文字体', name: 'Noto Sans SC', url: 'https://github.com/notofonts/noto-cjk', license: 'SIL OFL 1.1' },
      { desc: '字体子集引擎', name: 'harfbuzzjs', url: 'https://github.com/harfbuzz/harfbuzzjs', license: 'MIT' },
    ],
  },
]
</script>

<style scoped>
/* 软件自己的 LICENSE.md 第 1 行本身就是标题行；英文版用首行伪元素只放大这一行，
   其余正文仍是 14px。不改全文、不切片、也不新增第二层标题（会叠成两行）。 */
.license-own-pre::first-line {
  font-size: 1.125rem;
}

/* 语言切换按钮：毛玻璃主题给全局 button 加了 1px solid（未指定颜色 → currentColor 近黑）
   + box-shadow + ::before 荧光描边，会变成一圈黑色胶囊边框。按 .tb-btn 的先例整体剥掉，
   只靠底色区分选中态；border-radius 也要压回 rounded-lg，否则被 --radius-control 覆盖。 */
.lang-tab {
  border: none !important;
  box-shadow: none !important;
  border-radius: 0.5rem !important;
}
.lang-tab::before { display: none !important; }

/* 滚动区域美化 */
.bg-surface .overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}
.bg-surface .overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}
.bg-surface .overflow-y-auto::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.25);
  border-radius: var(--radius-xs);
}
</style>
