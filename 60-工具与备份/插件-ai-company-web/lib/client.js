/**
 * AI 公司 · Cordis 网页插件（浏览器半侧）
 * 严格按官方模板 templates/decoration/client.js 的格式
 */
window.__ModuleLoader__.load({
  id: 'local-ai-company-web',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    async function api(path, params) {
      const q = params ? '?' + new URLSearchParams(params).toString() : ''
      const r = await fetch(`/ai-company${path}${q}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    }

    // 模块级缓存：切走再回来不重新请求（照搬 dsh-context 常驻数据的思路）
    let DATA_CACHE = null
    async function getData(force) {
      const d = await api('/collect' + (force ? '?force=1' : ''))
      if (!d.ok) throw new Error(d.reason || '读取失败')
      DATA_CACHE = d
      return d
    }

    const S = {
      root: { padding: '12px 12px 32px', fontFamily: 'system-ui,-apple-system,sans-serif' },
      card: {
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 14, padding: 14, marginBottom: 12,
      },
      cardHead: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 },
      cardTitle: { fontSize: 15, fontWeight: 600 },
      sub: { fontSize: 11.5, opacity: 0.55 },
      // 2×2 KPI 网格
      kpiGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
      kpiCell: {
        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10, padding: '9px 11px',
      },
      kpiNum: { fontSize: 24, fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
      kpiLabel: { fontSize: 11, opacity: 0.55, marginTop: 2 },
      // 分区栏：一行放 5 个，短标签
      seg: { display: 'flex', gap: 4, marginBottom: 12 },
      segItem: (on) => ({
        flex: 1, textAlign: 'center', padding: '7px 2px',
        fontSize: 12.5, borderRadius: 8, cursor: 'pointer', userSelect: 'none',
        background: on ? '#4B67B4' : 'rgba(255,255,255,0.05)',
        color: on ? '#fff' : 'inherit',
        border: '1px solid ' + (on ? 'transparent' : 'rgba(255,255,255,0.07)'),
      }),
      row: {
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 0',
        borderBottom: '1px solid rgba(255,255,255,0.05)',
      },
      rowMain: { flex: 1, minWidth: 0 },
      rowTitle: { fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowSub: { fontSize: 11, opacity: 0.55, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowVal: { fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', opacity: 0.85 },
      dot: (tone) => ({
        width: 7, height: 7, borderRadius: 4, flexShrink: 0,
        background: tone === 'good' ? '#3fb950' : tone === 'bad' ? '#f85149' : tone === 'warn' ? '#d29922' : '#58a6ff',
      }),
      badge: (tone) => ({
        fontSize: 10, padding: '2px 6px', borderRadius: 5, fontWeight: 600, flexShrink: 0,
        background: tone === 'good' ? 'rgba(63,185,80,0.15)' : tone === 'bad' ? 'rgba(248,81,73,0.15)' : tone === 'warn' ? 'rgba(210,153,34,0.15)' : 'rgba(88,166,255,0.15)',
        color: tone === 'good' ? '#3fb950' : tone === 'bad' ? '#f85149' : tone === 'warn' ? '#d29922' : '#58a6ff',
      }),
      bar: { height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.09)', overflow: 'hidden', marginTop: 5 },
      barFill: (pct, tone) => ({
        height: '100%', width: Math.max(0, Math.min(100, pct)) + '%',
        background: tone === 'bad' ? '#f85149' : tone === 'warn' ? '#d29922' : '#3fb950',
        borderRadius: 3,
      }),
      acc: { borderBottom: '1px solid rgba(255,255,255,0.05)' },
      accHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0', cursor: 'pointer', userSelect: 'none' },
      accBody: { padding: '2px 0 10px 16px' },
      kv: { display: 'flex', fontSize: 11.5, padding: '3px 0', lineHeight: 1.5 },
      kvK: { opacity: 0.5, width: 52, flexShrink: 0 },
      kvV: { flex: 1, wordBreak: 'break-word' },
      tag: {
        fontSize: 10.5, padding: '2px 7px', borderRadius: 5,
        background: 'rgba(255,255,255,0.06)', opacity: 0.8,
      },
      // 2 列网格（工位/项目卡片）
      grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
      tile: {
        background: 'rgba(255,255,255,0.045)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10, padding: '10px 10px', minWidth: 0,
      },
      tileHead: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' },
      tileName: { fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 },
      tileSub: { fontSize: 10.5, opacity: 0.5, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      tileBody: { marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' },
      badgeSm: (tone) => ({
        fontSize: 9.5, padding: '1px 5px', borderRadius: 4, fontWeight: 600, flexShrink: 0,
        background: tone === 'good' ? 'rgba(63,185,80,0.15)' : tone === 'bad' ? 'rgba(248,81,73,0.15)' : tone === 'warn' ? 'rgba(210,153,34,0.15)' : 'rgba(88,166,255,0.15)',
        color: tone === 'good' ? '#3fb950' : tone === 'bad' ? '#f85149' : tone === 'warn' ? '#d29922' : '#58a6ff',
      }),
      groupLabel: { fontSize: 11.5, opacity: 0.5, margin: '14px 0 6px', fontWeight: 600, letterSpacing: 0.3 },
      btn: {
        padding: '6px 12px', fontSize: 12, borderRadius: 7, cursor: 'pointer',
        background: 'rgba(255,255,255,0.06)', color: 'inherit',
        border: '1px solid rgba(255,255,255,0.10)',
      },
      pre: {
        fontSize: 11.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'rgba(0,0,0,0.2)', padding: 12, borderRadius: 10, maxHeight: 400, overflow: 'auto',
        fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
      },
      empty: { fontSize: 12, opacity: 0.45, padding: '14px 0', textAlign: 'center' },
    }

    function KpiGrid({ items }) {
      return h('div', { style: S.kpiGrid },
        items.map((it, i) => h('div', { key: i, style: S.kpiCell },
          h('div', { style: { ...S.kpiNum, color: it.color } }, String(it.value)),
          h('div', { style: S.kpiLabel }, it.label),
        )),
      )
    }

    function Seg({ tabs, cur, onPick }) {
      return h('div', { style: S.seg },
        tabs.map((t, i) => h('div', { key: i, style: S.segItem(i === cur), onClick: () => onPick(i) }, t)),
      )
    }

    function Acc({ label, sub, badge, badgeTone, children, defaultOpen }) {
      const [open, setOpen] = useState(!!defaultOpen)
      return h('div', { style: S.acc },
        h('div', { style: S.accHead, onClick: () => setOpen(!open) },
          h('span', { style: { fontSize: 10, opacity: 0.4, width: 10 } }, open ? '▾' : '▸'),
          h('div', { style: S.rowMain },
            h('div', { style: S.rowTitle }, label),
            sub ? h('div', { style: S.rowSub }, sub) : null,
          ),
          badge ? h('span', { style: S.badge(badgeTone || 'info') }, badge) : null,
        ),
        open ? h('div', { style: S.accBody }, children) : null,
      )
    }

    function KV({ k, v }) {
      return h('div', { style: S.kv },
        h('div', { style: S.kvK }, k),
        h('div', { style: S.kvV }, v || '—'),
      )
    }

    // 2 列网格卡片（工位/项目用），点击展开详情
    function Tile({ name, sub, badge, badgeTone, bar, next, details, defaultOpen }) {
      const [open, setOpen] = useState(!!defaultOpen)
      return h('div', { style: S.tile },
        h('div', { style: S.tileHead, onClick: () => setOpen(!open) },
          h('span', { style: { fontSize: 9, opacity: 0.4, width: 9 } }, open ? '▾' : '▸'),
          h('div', { style: S.tileName }, name),
          badge ? h('span', { style: S.badgeSm(badgeTone || 'info') }, badge) : null,
        ),
        h('div', { style: { ...S.tileSub, paddingLeft: 15 } }, sub),
        bar !== null && bar !== undefined
          ? h('div', { style: S.bar }, h('div', { style: S.barFill(bar, bar >= 80 ? 'good' : bar >= 40 ? 'warn' : 'bad') }))
          : null,
        open ? h('div', { style: S.tileBody },
          next ? h('div', {
            style: { background: 'rgba(88,166,255,0.08)', padding: '6px 8px', borderRadius: 6, fontSize: 10.5, lineHeight: 1.45, marginBottom: 6 },
          }, next) : null,
          details && details.map((d, i) => h(KV, { key: i, k: d[0], v: d[1] })),
        ) : null,
      )
    }

    // ── 主视图 ────────────────────────────────────────────
    function AiCompany() {
      // 有缓存就直接显示，不再闪「正在读取」
      const [data, setData] = useState(DATA_CACHE)
      const [err, setErr] = useState(null)
      const [tab, setTab] = useState(0)
      const [file, setFile] = useState(null)
      const [loading, setLoading] = useState(!DATA_CACHE)
      const [q, setQ] = useState('')          // 搜索
      const [docFilter, setDocFilter] = useState({ kind: null })  // 文档类型筛选
      const [timeline, setTimeline] = useState(null)   // 事件流内容（就地显示）

      const load = useCallback(async (force) => {
        if (!force && DATA_CACHE) { setData(DATA_CACHE); setLoading(false); return }
        setLoading(true); setErr(null)
        try {
          const d = await getData(force)
          setData(d)
        } catch (e) { setErr(String(e.message || e)) }
        finally { setLoading(false) }
      }, [])

      useEffect(() => { void load(false) }, [load])

      const openFile = useCallback(async (p) => {
        try {
          const r = await api('/file', { path: p })
          setFile(r.ok ? r : { ok: false, text: r.reason })
        } catch (e) { setFile({ ok: false, text: String(e.message || e) }) }
      }, [])

      // 事件流：就地加载显示（不跳页）
      const openTimeline = useCallback(async () => {
        try {
          const r = await api('/timeline')
          setTimeline(r.ok ? r : { ok: false, text: r.reason })
        } catch (e) { setTimeline({ ok: false, text: String(e.message || e) }) }
      }, [])

      // 事件流就地预览（覆盖面板，带关闭）
      if (timeline) {
        return h('div', { style: S.root },
          h('div', { style: S.card },
            h('div', { style: S.cardHead },
              h('span', { style: S.cardTitle }, '事件流 · 10秒接上'),
              h('button', { style: S.btn, onClick: () => setTimeline(null) }, '关闭'),
            ),
            timeline.ok ? h('pre', { style: { ...S.pre, maxHeight: '62vh' } }, timeline.text || '（空）')
                        : h('div', { style: S.sub }, timeline.text),
          ),
        )
      }

      if (loading) return h('div', { style: S.root }, h('div', { style: S.sub }, '正在读取公司目录…'))
      if (err) return h('div', { style: S.root },
        h('div', { style: S.card }, h('div', { style: S.cardTitle }, '读取失败'),
          h('div', { style: S.sub }, err),
          h('button', { style: { ...S.btn, marginTop: 10 }, onClick: load }, '重试')))

      if (file) {
        return h('div', { style: S.root },
          h('div', { style: S.card },
            h('div', { style: S.cardHead },
              h('span', { style: { flex: 1, fontSize: 13, fontWeight: 600 } }, (file.path || '').split('/').pop() || '文件'),
              h('button', { style: S.btn, onClick: () => setFile(null) }, '关闭'),
            ),
            file.ok ? h('pre', { style: S.pre }, file.text || '（空）') : h('div', { style: S.sub }, file.text),
          ),
        )
      }

      const TABS = ['总览', '项目', '文档', '团队', '制度']
      const d = data
      const pct = d.autoTotal ? Math.round(d.autoPassed / d.autoTotal * 100) : 0
      const bad = d.seats.filter(s => s.dot === 'bad')
      const allProj = [...d.projects.doing.map(p => ({ ...p, st: 'doing' })), ...d.projects.done.map(p => ({ ...p, st: 'done' }))]

      // 文档分组
      const byG = new Map()
      for (const x of d.docs || []) {
        if (!byG.has(x.project)) byG.set(x.project, [])
        byG.get(x.project).push(x)
      }
      const groups = [...byG.entries()].sort((a, b) => b[1].length - a[1].length)

      const doing = d.projects.doing        // 全分区共用（原来只在总览里定义，项目页引用会崩）
      let body = null
      let renderErr = null

      // ══════ 总览（一屏看全局：状态 → 数字 → 分布）══════
      if (tab === 0) {
        const alerts = []
        for (const s of bad) alerts.push({ who: s.who, what: `对话读不到：${s.cant}`, tone: 'bad', mark: '✘' })
        for (const p of doing) {
          if (!p.hasZip) alerts.push({ who: p.name, what: '缺 ZIP 归档（规矩六）', tone: 'warn', mark: '⚠' })
          if (p.pct === null) alerts.push({ who: p.name, what: '没有进度标记', tone: 'warn', mark: '⚠' })
        }
        if (d.autoPassed < d.autoTotal) {
          alerts.push({ who: '规矩体检', what: `${d.autoTotal - d.autoPassed} 项可检未通过`, tone: 'warn', mark: '⚠' })
        }

        // 文档类型 Top
        const typeCount = new Map()
        for (const x of d.docs || []) typeCount.set(x.kindZh, (typeCount.get(x.kindZh) || 0) + 1)
        const topTypes = [...typeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        const typeColors = ['#58a6ff', '#3fb950', '#d29922', '#a371f7', '#f778ba', '#8b949e']

        body = h('div', null,
          // ⓪ 事件流入口（阶段①记忆的最小闭环成果，置顶）
          h('div', {
            style: { ...S.card, background: 'rgba(88,166,255,0.08)', borderColor: 'rgba(88,166,255,0.28)', cursor: 'pointer' },
            onClick: openTimeline,
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontSize: 16 } }, '⚡'),
              h('div', { style: S.rowMain },
                h('div', { style: S.cardTitle }, '事件流 · 10 秒接上'),
                h('div', { style: S.rowSub }, '断上下文/换 AI 也能看懂做到哪 · 点开看'),
              ),
              h('span', { style: S.badgeSm('info') }, '查看'),
            ),
          ),

          // ① 状态一句话 + 异常
          alerts.length ? h('div', {
            style: { ...S.card, background: 'rgba(248,81,73,0.06)', borderColor: 'rgba(248,81,73,0.22)' },
          },
            h('div', { style: S.cardHead },
              h('span', { style: S.cardTitle }, `需要你处理 ${alerts.length}`),
            ),
            ...alerts.slice(0, 4).map((a, i) => h('div', {
              key: i,
              style: { ...S.row, ...(i === Math.min(3, alerts.length - 1) ? { borderBottom: 'none' } : {}) },
            },
              h('span', { style: { fontSize: 11, width: 13, color: a.tone === 'bad' ? '#f85149' : '#d29922' } }, a.mark),
              h('div', { style: S.rowMain },
                h('div', { style: S.rowTitle }, a.who),
                h('div', { style: S.rowSub }, a.what),
              ),
            )),
          ) : h('div', { style: { ...S.card, background: 'rgba(63,185,80,0.06)', borderColor: 'rgba(63,185,80,0.22)' } },
            h('div', { style: { ...S.cardTitle, color: '#3fb950' } }, '✓ 一切正常'),
          ),

          // ② KPI 2×2
          h('div', { style: S.card },
            h(KpiGrid, { items: [
              { value: allProj.length, label: `${doing.length} 进行中`, color: '#58a6ff' },
              { value: d.docs.length, label: `${groups.length} 个来源`, color: '#3fb950' },
              { value: d.seats.length, label: '个工位', color: 'inherit' },
              { value: `${d.autoPassed}/${d.autoTotal}`, label: '规矩可检', color: pct === 100 ? '#3fb950' : '#d29922' },
            ]}),
          ),

          // ③ 文档构成（占比条，不重复项目区内容）
          h('div', { style: S.card },
            h('div', { style: S.cardHead },
              h('span', { style: S.cardTitle }, '文档构成'),
              h('span', { style: S.sub }, `${d.docs.length} 份`),
            ),
            // 横向占比条
            h('div', { style: { display: 'flex', height: 7, borderRadius: 4, overflow: 'hidden', background: 'rgba(255,255,255,0.06)' } },
              ...topTypes.map(([t, n], i) => h('div', {
                key: i,
                style: { width: (n / d.docs.length * 100) + '%', background: typeColors[i % typeColors.length] },
              }))
            ),
            // 图例
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px 12px', marginTop: 9 } },
              ...topTypes.map(([t, n], i) => h('div', {
                key: i,
                style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, opacity: 0.75 },
              },
                h('span', { style: { width: 7, height: 7, borderRadius: 2, background: typeColors[i % typeColors.length] } }),
                h('span', null, `${t} ${n}`),
              ))
            ),
          ),

          // ④ 项目一句话摘要（引导去项目区，不重复详情）
          h('div', { style: S.card },
            h('div', { style: S.cardHead },
              h('span', { style: S.cardTitle }, '项目概况'),
              h('span', { style: S.sub }, `${d.projects.done.length} 已归档`),
            ),
            ...doing.slice(0, 4).map((p, i) => h('div', {
              key: i,
              style: { ...S.row, ...(i === Math.min(3, doing.length - 1) ? { borderBottom: 'none' } : {}) },
            },
              h('span', { style: S.badgeSm(p.pct !== null && p.pct >= 80 ? 'good' : p.pct !== null && p.pct >= 40 ? 'warn' : 'bad') }, p.pct !== null ? `${p.pct}%` : '无进度'),
              h('div', { style: S.rowMain },
                h('div', { style: S.rowTitle }, p.name),
                p.nextStep ? h('div', { style: S.rowSub }, `→ ${p.nextStep}`) : null,
              ),
            )),
          ),
        )
      }

      // ══════ 项目（按分类分组）══════
      else if (tab === 1) {
        try {
        const CATS = [
          { key: 'product', zh: '产品研发' },
          { key: 'ops', zh: '公司运营' },
          { key: 'review', zh: '评审交付' },
          { key: 'infra', zh: '基础设施' },
          { key: 'other', zh: '其他' },
        ]
        const byCat = new Map()
        for (const p of allProj) {
          const k = p.cat || 'other'
          if (!byCat.has(k)) byCat.set(k, [])
          byCat.get(k).push(p)
        }

        body = h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('span', { style: S.cardTitle }, `项目 ${allProj.length}`),
            h('span', { style: S.sub }, `${doing.length} 进行中 · ${d.projects.done.length} 归档`),
          ),
          // 统一 2 列网格：分类只是卡片上的小标签，不再每组单独网格
          h('div', { style: S.grid2 },
            ...allProj.map((p) => {
              const details = [
                ['分类', p.catZh || '其他'],
                ['进度', p.pct !== null ? `${p.pct}%${p.note ? ` (${p.note})` : ''}` : '文件里没有进度标记'],
              ]
              if (p.pctSrc) details.push(['来源', p.pctSrc])
              details.push(['文档', `${p.md} 份`])
              details.push(['ZIP', p.hasZip ? '✓ 已有' : '✘ 缺（规矩六）'])
              if (p.parts && p.parts.length) details.push(['结构', p.parts.map(x => `${x.name} ${x.n}`).join(' · ')])
              return h(Tile, {
                key: p.name,
                name: p.name,
                sub: `${p.catZh || '其他'} · ${p.pct !== null ? p.pct + '%' : '无进度'} · ${p.md}份`,
                badge: p.st === 'done' ? '归档' : (p.hasZip ? null : '缺ZIP'),
                badgeTone: p.st === 'done' ? 'good' : 'warn',
                bar: p.pct,
                next: p.nextStep ? `→ ${p.nextStep}` : null,
                details,
                defaultOpen: !p.hasZip && p.st !== 'done',
              })
            })
          ),
          allProj.length === 0 ? h('div', { style: S.empty }, '暂无项目') : null,
        )
        } catch (e) { renderErr = String(e && e.stack ? e.stack.split('\n').slice(0,3).join(' | ') : e) }
      }

      // ══════ 文档（类型筛选 + 搜索 + 来源分组）══════
      else if (tab === 2) {
        const kw = q.trim().toLowerCase()
        const typeFilter = docFilter.kind

        // 类型分布（用于筛选 chips）
        const typeCount = new Map()
        for (const x of d.docs || []) typeCount.set(x.kindZh, (typeCount.get(x.kindZh) || 0) + 1)
        const types = [...typeCount.entries()].sort((a, b) => b[1] - a[1])

        // 过滤
        let filtered = d.docs || []
        if (typeFilter) filtered = filtered.filter(x => x.kindZh === typeFilter)
        if (kw) filtered = filtered.filter(x => x.name.toLowerCase().includes(kw) || x.project.toLowerCase().includes(kw))

        // 按来源分组
        const fg = new Map()
        for (const x of filtered) {
          if (!fg.has(x.project)) fg.set(x.project, [])
          fg.get(x.project).push(x)
        }
        const fgroups = [...fg.entries()].sort((a, b) => b[1].length - a[1].length)

        body = h('div', null,
          h('div', { style: S.card },
            h('div', { style: S.cardHead },
              h('span', { style: S.cardTitle }, `文档 ${filtered.length}`),
              h('span', { style: S.sub }, typeFilter ? typeFilter : `${types.length} 种类型`),
            ),
            // 类型筛选 chips（横向换行）
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 9 } },
              h('span', {
                onClick: () => setDocFilter({ kind: null }),
                style: {
                  fontSize: 10.5, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                  background: !typeFilter ? '#4B67B4' : 'rgba(255,255,255,0.05)',
                  color: !typeFilter ? '#fff' : 'inherit',
                },
              }, `全部 ${d.docs.length}`),
              ...types.map(([t, n]) => h('span', {
                key: t,
                onClick: () => setDocFilter({ kind: typeFilter === t ? null : t }),
                style: {
                  fontSize: 10.5, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
                  background: typeFilter === t ? '#4B67B4' : 'rgba(255,255,255,0.05)',
                  color: typeFilter === t ? '#fff' : 'inherit',
                },
              }, `${t} ${n}`)),
            ),
            // 搜索框
            h('input', {
              value: q,
              onChange: (e) => setQ(e.target.value),
              placeholder: '搜索文档名…',
              style: {
                width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 12.5,
                borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.05)', color: 'inherit', outline: 'none',
                marginBottom: 10,
              },
            }),
            // 分组列表
            fgroups.length ? fgroups.slice(0, 10).map(([name, list]) => h(Acc, {
              key: name,
              label: name,
              sub: `${list.length} 份`,
              children: h('div', null,
                ...list.slice(0, 20).map((x, i) => h('div', {
                  key: i,
                  style: { ...S.row, cursor: 'pointer', ...(i === Math.min(19, list.length - 1) ? { borderBottom: 'none' } : {}) },
                  onClick: () => openFile(x.path),
                },
                  h('span', { style: S.badgeSm('info') }, x.kindZh),
                  h('div', { style: S.rowMain },
                    h('div', { style: S.rowTitle }, x.name),
                  ),
                  h('div', { style: S.rowVal }, Math.round(x.bytes / 1024) + 'K'),
                )),
                list.length > 20 ? h('div', { style: S.sub }, `还有 ${list.length - 20} 份`) : null,
              ),
            })) : h('div', { style: S.empty }, kw || typeFilter ? '没有匹配的文档' : '暂无文档'),
          ),
        )
      }

      // ══════ 团队（能力边界合并进员工）══════
      else if (tab === 3) {
        body = h('div', { style: S.card },
          h('div', { style: S.cardHead },
            h('span', { style: S.cardTitle }, `工位 ${d.seats.length}`),
            h('span', { style: S.sub }, '点开看职责与文件'),
          ),
          h('div', { style: S.grid2 },
            ...d.seats.map((s) => h(Tile, {
              key: s.dir,
              name: s.who,
              sub: `${s.role} · ${s.files} 份`,
              badge: s.dot === 'good' ? '可用' : s.dot === 'bad' ? '异常' : '待验',
              badgeTone: s.dot,
              details: [
                ['岗位', s.role],
                ['状态', s.bench],
                ['能做', s.can],
                ['不能', s.cant],
                ['文件', `${s.files} 份`],
              ],
            }))
          ),
        )
      }

      // ══════ 制度（可检置顶 + 主题分组折叠）══════
      else {
        const m = new Map(d.checks.map(c => [c.n, c]))
        const RULES = [
          { n: 1, t: '一个项目一个文件夹', auto: true, g: '目录与命名' },
          { n: 2, t: '会分类', auto: true, g: '目录与命名' },
          { n: 3, t: '资料归档不靠记忆', g: '目录与命名' },
          { n: 4, t: '房间不能乱用', auto: true, g: '目录与命名' },
          { n: 5, t: '命名要能看懂', g: '目录与命名' },
          { n: 6, t: '每个项目必须有 ZIP', auto: true, g: '归档与留痕' },
          { n: 7, t: '改动要留痕', g: '归档与留痕' },
          { n: 8, t: 'DSH 读对话后记录+更新', auto: true, g: '归档与留痕' },
          { n: 9, t: '汇总前必须先同步', g: '协作与发言' },
          { n: 10, t: '区分原话/判断/待确认', g: '协作与发言' },
          { n: 11, t: '矛盾要上报', g: '协作与发言' },
          { n: 12, t: '只出建议不拍板', g: '协作与发言' },
          { n: 13, t: '员工用「结论：」', g: '协作与发言' },
          { n: 16, t: '分活四步', g: '协作与发言' },
          { n: 14, t: '新 AI 入职 7 步', g: '入职与知识' },
          { n: 15, t: '开工前必读岗位知识', g: '入职与知识' },
          { n: 17, t: '通用修复不打补丁', g: '质量与检查' },
          { n: 18, t: '一次性同步更新', g: '质量与检查' },
          { n: 19, t: '归档成 ZIP 清外围', auto: true, g: '质量与检查' },
          { n: 20, t: '工位回到空座位', g: '质量与检查' },
          { n: 21, t: '非作者交叉验收', g: '质量与检查' },
        ]
        const autoRules = RULES.filter(r => r.auto)
        const manualRules = RULES.filter(r => !r.auto)
        const fail = autoRules.filter(r => { const c = m.get(r.n); return c && !c.ok })

        body = h('div', null,
          // ① 可检结果置顶
          h('div', { style: S.card },
            h('div', { style: S.cardHead },
              h('span', { style: S.cardTitle }, '机器可检'),
              h('span', { style: S.sub }, `${d.autoPassed}/${d.autoTotal} 通过`),
            ),
            h('div', { style: S.bar }, h('div', { style: S.barFill(pct, pct === 100 ? 'good' : 'warn') })),
            h('div', { style: { marginTop: 10 } },
              ...autoRules.map((r, i) => {
                const c = m.get(r.n)
                const ok = c?.ok
                return h('div', {
                  key: r.n,
                  style: { ...S.row, ...(i === autoRules.length - 1 ? { borderBottom: 'none' } : {}) },
                },
                  h('span', { style: { fontSize: 11, width: 14, color: ok ? '#3fb950' : '#f85149' } }, ok ? '✓' : '✘'),
                  h('div', { style: S.rowMain },
                    h('div', { style: S.rowTitle }, `${r.n}. ${r.t}`),
                    c?.detail ? h('div', { style: S.rowSub }, c.detail) : null,
                  ),
                  h('span', { style: S.badgeSm(ok ? 'good' : 'bad') }, ok ? '通过' : '未过'),
                )
              })
            ),
          ),

          // ② 人工规矩按主题折叠
          h('div', { style: S.card },
            h('div', { style: S.cardHead },
              h('span', { style: S.cardTitle }, '人工执行'),
              h('span', { style: S.sub }, `${manualRules.length} 条 · 点开看`),
            ),
            ...['目录与命名', '协作与发言', '入职与知识', '质量与检查'].map(g => {
              const list = manualRules.filter(r => r.g === g)
              if (!list.length) return null
              return h(Acc, {
                key: g,
                label: g,
                sub: `${list.length} 条`,
                children: h('div', null,
                  ...list.map((r, i) => h('div', {
                    key: r.n,
                    style: { ...S.row, padding: '6px 0', ...(i === list.length - 1 ? { borderBottom: 'none' } : {}) },
                  },
                    h('div', { style: { ...S.rowVal, width: 18, opacity: 0.35 } }, r.n),
                    h('div', { style: S.rowMain }, h('div', { style: S.rowTitle }, r.t)),
                  ))
                ),
              })
            }),
          ),
        )
      }

      // 渲染兜底：出错时显示原因，不显示空白
      if (renderErr) {
        body = h('div', { style: S.card },
          h('div', { style: S.cardTitle }, '这个分区渲染出错'),
          h('div', { style: { ...S.sub, marginTop: 8, fontFamily: 'monospace', wordBreak: 'break-word' } }, renderErr),
          h('button', { style: { ...S.btn, marginTop: 10 }, onClick: () => { setTab(0) } }, '回总览'),
        )
      }

      return h('div', { style: S.root },
        h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 10 } },
          h('div', { style: { flex: 1, fontSize: 16, fontWeight: 700 } }, 'AI 公司'),
          h('button', { style: S.btn, onClick: () => load(true) }, '刷新'),
        ),
        h(Seg, { tabs: TABS, cur: tab, onPick: setTab }),
        body,
        h('div', { style: { ...S.sub, textAlign: 'center', marginTop: 14 } },
          `${agoText(d.at)}读取`),
      )
    }

    // 千问第 6 条：相对时间，不用心算
    function agoText(ts) {
      const s = Math.floor((Date.now() - ts) / 1000)
      if (s < 60) return '刚刚'
      if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
      if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
      return `${Math.floor(s / 86400)} 天前`
    }

    const NS = 'ai-company'
    const DICTS = {
      zh: { tab: 'AI公司' },
      en: { tab: 'AI Co' },
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'ai-company: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'ai-company',
          order: 30,
          locale: NS,
          label: () => t('tab'),
        }, AiCompany))
      },
    }
  },
})
