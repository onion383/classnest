/**
 * multi-class-test.cjs —— 「一个账号多个班级」真实 HTTP 回归
 *
 * 设计：一班一库（不是一库多班）。每个班是一个独立的加密库，账号在库外（index.db
 * 的 accounts 表）统一持有凭证，registry.account_id 把两者连起来。
 *
 * 这里补源码判据抓不到的东西 —— 只有真的把两个班都跑起来才看得见：
 *   · 登录返回的 classes 列表是否完整（登录时还没开库，只能读 registry.class_name）；
 *   · 新增班级后是否真的多了一个独立库，而不是同一库里多了一行；
 *   · **切班后读到的数据是不是另一个班的**（决定性的那条：数据没隔离就等于没做成）；
 *   · 切班失败的路径：拿别人的 slug 必须是 404，不能因为「存在」就放行；
 *   · 切班必须换发新 token —— dbSlug 写在 JWT 里，服务端改状态前端不知道。
 *
 * 跑法：node testjs/smoke/multi-class-test.cjs
 * 退出码：0 = 全部通过；1 = 有断言失败
 */
const { startIsolatedBackend } = require('./_isolated-backend.cjs')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  → ${detail}`}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const h = await startIsolatedBackend()
  const api = async (method, p, { token, body } = {}) => {
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    if (body) headers['Content-Type'] = 'application/json'
    const r = await fetch(h.base + p, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    let json = null
    try { json = await r.json() } catch (_) { /* 非 JSON 响应 */ }
    return { status: r.status, json }
  }

  try {
    // ---- 1. 注册账号 A，顺手给第一个班起名 ----
    const reg = await api('POST', '/api/register', {
      body: { username: '多班测试甲', password: 'pw123456', role: 'teacher', level: 'password', className: '初三七班' },
    })
    check('注册成功并直接签发登录态', reg.status === 200 && !!reg.json?.token, `status=${reg.status} body=${JSON.stringify(reg.json)}`)
    let tokenA = reg.json?.token

    const c1 = await api('GET', '/api/account/classes', { token: tokenA })
    check('登录后能列班级，且班名就是注册时给的名字',
      c1.status === 200 && c1.json?.classes?.length === 1 && c1.json.classes[0].className === '初三七班',
      `status=${c1.status} body=${JSON.stringify(c1.json)}`)
    const slugA1 = c1.json?.classes?.[0]?.slug
    const current1 = c1.json?.current
    check('当前班 = 列表里那个班', !!current1 && current1 === slugA1, `current=${current1} slug=${slugA1}`)

    // ---- 2. 新增第二个班 ----
    const add = await api('POST', '/api/account/class', { token: tokenA, body: { className: '初三八班' } })
    check('新增班级成功', add.status === 200 && !!add.json?.slug, `status=${add.status} body=${JSON.stringify(add.json)}`)
    const slugA2 = add.json?.slug
    check('新班是一个独立的库标识（不是复用原来的）', slugA2 && slugA2 !== slugA1, `${slugA1} vs ${slugA2}`)
    check('新增后班级列表变成 2 个', add.json?.classes?.length === 2, `classes=${JSON.stringify(add.json?.classes)}`)

    // ---- 2.1 班名在账号内唯一：新增与改名都要被拒 ----
    // 立这条的原因：切换器里两个同名项只差 slug（用户看不见），根本没法区分；
    // 而且创建后会自动切进新班，重名会让用户以为「没切过去」。
    const dupAdd = await api('POST', '/api/account/class', { token: tokenA, body: { className: '初三七班' } })
    check('新增同名班级被拒（409）', dupAdd.status === 409,
      `status=${dupAdd.status} body=${JSON.stringify(dupAdd.json)}`)
    const afterDup = await api('GET', '/api/account/classes', { token: tokenA })
    check('被拒后没有偷偷多建一个班（仍是 2 个）', afterDup.json?.classes?.length === 2,
      `classes=${afterDup.json?.classes?.length}`)

    // ---- 3. 在班 1 写班级信息 ----
    // widget-settings 挂在让路链的 deferredLoaders 里（启动后约 85ms 才注册）。
    // 等一小段再打，否则拿到的是「路由还没挂」的 404，会被误读成接口不存在。
    await wait(300)
    const put1 = await api('PUT', '/api/widget-settings/class-info', {
      token: tokenA,
      body: { name: '七班的班名', motto: '七班口号', mottoStyle: '', xuefeng: '' },
    })
    check('班 1 写入班级信息成功', put1.status === 200, `status=${put1.status}`)

    // 改名同样受唯一约束：只在「新增」拦是不够的，改个名照样能造出两个同名班。
    // 这里把班 1 改成班 2 的名字，必须被拒；若放行，下面「切回班 1 仍是七班的班名」会跟着红。
    const dupRename = await api('PUT', '/api/widget-settings/class-info', {
      token: tokenA,
      body: { name: '初三八班', motto: '', mottoStyle: '', xuefeng: '' },
    })
    check('改班名为另一个班的同名被拒（409）', dupRename.status === 409,
      `status=${dupRename.status} body=${JSON.stringify(dupRename.json)}`)

    // 改成自己原来的名字不算重名（比较时排除了当前班），必须放行
    const sameRename = await api('PUT', '/api/widget-settings/class-info', {
      token: tokenA,
      body: { name: '七班的班名', motto: '七班口号', mottoStyle: '', xuefeng: '' },
    })
    check('改回自己原来的名字不算重名（200）', sameRename.status === 200,
      `status=${sameRename.status} body=${JSON.stringify(sameRename.json)}`)

    // ---- 4. 切到班 2 ----
    const sw = await api('POST', '/api/account/switch-class', { token: tokenA, body: { slug: slugA2 } })
    check('切班成功', sw.status === 200, `status=${sw.status} body=${JSON.stringify(sw.json)}`)
    check('切班换发了新 token（dbSlug 在 JWT 里，不换 token 前端就还在读旧班）',
      !!sw.json?.token && sw.json.token !== tokenA, 'token 未变化')
    check('新 token 里的当前班已变成班 2', sw.json?.user?.dbSlug === slugA2,
      `dbSlug=${sw.json?.user?.dbSlug}`)
    tokenA = sw.json?.token

    // 决定性的一条：班 2 是全新的库，不该看到班 1 写的班名
    const ci2 = await api('GET', '/api/widget-settings/class-info', { token: tokenA })
    check('切到班 2 后读到的是空班级信息（数据真的隔离到另一个库）',
      ci2.status === 200 && !ci2.json?.data?.name,
      `status=${ci2.status} name=${JSON.stringify(ci2.json?.data?.name)}`)

    // ---- 5. 在班 2 写不同的班名，切回去看是否各归各的 ----
    await api('PUT', '/api/widget-settings/class-info', {
      token: tokenA,
      body: { name: '八班的班名', motto: '', mottoStyle: '', xuefeng: '' },
    })
    const back = await api('POST', '/api/account/switch-class', { token: tokenA, body: { slug: slugA1 } })
    check('切回班 1 成功', back.status === 200, `status=${back.status}`)
    tokenA = back.json?.token

    const ci1 = await api('GET', '/api/widget-settings/class-info', { token: tokenA })
    check('班 1 仍是自己的班名（两个班互不覆盖）',
      ci1.json?.data?.name === '七班的班名', `name=${JSON.stringify(ci1.json?.data?.name)}`)

    const listAfter = await api('GET', '/api/account/classes', { token: tokenA })
    const names = (listAfter.json?.classes || []).map((c) => c.className).sort()
    check('改班名已同步到登记表（登录时列班级读的就是它）',
      names.includes('七班的班名') && names.includes('八班的班名'),
      `classes=${JSON.stringify(names)}`)

    // ---- 6. 越权：另一个账号不能切到 A 的班 ----
    const regB = await api('POST', '/api/register', {
      body: { username: '多班测试乙', password: 'pw123456', role: 'teacher', level: 'password', className: '乙的班' },
    })
    const tokenB = regB.json?.token
    check('第二个账号注册成功（同名才该被拒，不同名互不影响）', !!tokenB, `status=${regB.status}`)

    const cross = await api('POST', '/api/account/switch-class', { token: tokenB, body: { slug: slugA2 } })
    check('切到别人的班被拒绝（404，且不区分「不存在」与「不是你的」）',
      cross.status === 404, `status=${cross.status} body=${JSON.stringify(cross.json)}`)

    // ---- 7. 同一账号注册第二个同名账号必须被拒 ----
    const dup = await api('POST', '/api/register', {
      body: { username: '多班测试甲', password: 'pw123456', role: 'teacher', level: 'password' },
    })
    check('同名账号仍不能重复注册', dup.status === 409, `status=${dup.status}`)

    // ---- 8. 改用户名后，切到另一个班仍能登录 ----
    // 账号名是账号维度的属性：改名必须同步到该账号名下所有 registry 行 + accounts，
    // 否则切到另一个班时按新名一条登记都查不到，等于把自己锁在门外。
    const ren = await api('PUT', '/api/account/username', {
      token: tokenA,
      body: { newUsername: '多班测试甲改', password: 'pw123456' },
    })
    check('改名成功', ren.status === 200, `status=${ren.status} body=${JSON.stringify(ren.json)}`)

    const relogin = await api('POST', '/api/login', {
      body: { username: '多班测试甲改', password: 'pw123456' },
    })
    check('用新名能重新登录', relogin.status === 200 && !!relogin.json?.token,
      `status=${relogin.status} body=${JSON.stringify(relogin.json)}`)
    check('改名后班级数仍是 2（登记表每一行都改到了）',
      relogin.json?.classes?.length === 2, `classes=${JSON.stringify(relogin.json?.classes)}`)

    const swAfterRename = await api('POST', '/api/account/switch-class', {
      token: relogin.json?.token,
      body: { slug: slugA2 },
    })
    check('改名后仍能切到另一个班（各库 users 名不同步也要能进）',
      swAfterRename.status === 200, `status=${swAfterRename.status} body=${JSON.stringify(swAfterRename.json)}`)

    // ---- 8. 删除当前班级（只删这一个库，账号还在） ----
    // 此时令牌里的当前班是 slugA2（上一步切过去了）。删掉它，应自动落到 slugA1。
    const delClass = await api('DELETE', '/api/account/class', { token: swAfterRename.json?.token })
    check('删除当前班级成功', delClass.status === 200,
      `status=${delClass.status} body=${JSON.stringify(delClass.json)}`)
    check('删除后班级数变成 1', delClass.json?.classes?.length === 1,
      `classes=${JSON.stringify(delClass.json?.classes)}`)
    check('删除的是被切过去的那个班，剩下的是另一个',
      delClass.json?.current && delClass.json.current !== slugA2 && delClass.json.current === slugA1,
      `current=${delClass.json?.current} slugA1=${slugA1} slugA2=${slugA2}`)
    check('删除后换发了新 token（会话跟着挪到剩下的班）',
      !!delClass.json?.token && delClass.json.token !== swAfterRename.json?.token, 'token 未变化')

    // 用新 token 读数据：如果会话没跟着挪，这里会打到已删的库上直接 500
    const afterDel = await api('GET', '/api/widget-settings/class-info', { token: delClass.json?.token })
    check('删除后能正常读剩下的班（会话确实挪走了，没有指向已删的库）',
      afterDel.status === 200, `status=${afterDel.status} body=${JSON.stringify(afterDel.json)}`)
    check('剩下的是班 1 的数据（班名还是当初写的那个，没有被连带删掉）',
      afterDel.json?.data?.name === '七班的班名', `name=${JSON.stringify(afterDel.json?.data?.name)}`)

    // 只剩一个班时不允许再删：那件事的入口叫「删除账号」
    const delLast = await api('DELETE', '/api/account/class', { token: delClass.json?.token })
    check('最后一个班不能删（400，指向删除账号）', delLast.status === 400,
      `status=${delLast.status} body=${JSON.stringify(delLast.json)}`)
  } finally {
    await h.stop()
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => {
  console.error('脚本异常:', e)
  process.exit(1)
})
