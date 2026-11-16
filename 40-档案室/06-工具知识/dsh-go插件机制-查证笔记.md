# dsh-go 插件机制 · 查证笔记

- 查证时间：2026-11-16 15:15
- 查证原因：AI公司插件装好了但界面看不到，我猜了 6 次没猜中
- 规矩依据：**规矩二十二 —— 先全网学习相关知识，再动手**

---

## 一、我用的查证方法（可复用）

| 方法 | 命令 | 能查到什么 |
|---|---|---|
| **配置树终审** | `dsh --profile web --dump-config` | **最终组合的完整配置树**，最权威 |
| 清单严格校验 | 桥接自带的 `checkManifest()` | 清单是否合规、哪些字段有问题 |
| 桥接解析 | `parseManifest()` | 解析出的 items、issues |
| 分层解剖 | `loadProfile()` | 22 个 bundle layer、12 个 patch、skippedBundles |
| 组合验证 | `composeEntries()` | 229/230 条最终条目 |
| 包解析 | `require.resolve('<pkg>/package.json')` | 包能否被找到 |

---

## 二、关键结论（已证实）

### 2.1 profile 的加载顺序（源码 profile-boot.js）

```
base bundle
  ↓
每个 dsh.profile.bundles 里的 bundle（按顺序）
  ↓
profile 自己的 cordis.patch.yml
  ↓
$DSH_HOME/cordis.patch.yml（home 层，优先级最高）
  ↓
--patch 覆盖层（命令行）
  ↓
遥测开关
```

**`dsh plugin add` 只做两件事**：
1. 往 `package.json` 的 `dependencies` 加一行
2. 往 `package.json` 的 `dsh.profile.bundles` 追加包名

**它不会写 `cordis.yml`，因为 `cordis.yml` 每次启动都被重写成空 `[]`**
（源码：`writeFileSync(join(profile.dir, "cordis.yml"), PROFILE_ROOT_CONFIG)`）

### 2.2 原生面板要显示，必须过三关

| 关 | 条件 | 源码位置 |
|---|---|---|
| 1 | bundle 在 `dsh.profile.bundles` 里 | `loadProfile` |
| 2 | 清单 `dshGo` 字段合规 | `checkManifest` |
| 3 | **`ctx.dshGo.panel(id, ...)` 真的注册了** | `manifest.js` 的 `ready = reg !== undefined` |

**第 3 关最关键**：`ready=false` 时面板不显示，而且**不报错**（只有 `no-handler` warn）。

### 2.3 placement 的协商规则

```js
// limits.js
PLACEMENTS = ["session.tab", "features", "chat.panel", "plugin"]
NEGOTIATED_PLACEMENTS = ["plugin"]   // 只有 plugin 需要 App 说支持才保留
```

- `session.tab` / `features` / `chat.panel` → 不用协商，一定保留
- `plugin` → 需要 `caps.surfaces` 含 `plugin`
- 全被过滤掉时 → 退回 `session.tab`（源码 `placementFor`）

### 2.4 composer.strip 必须满足一条

```js
ready = liveStrip || tappable || it.text !== undefined
```

**没有 `text`、没有 handler、没有 panel → 不显示。**
（我第一次写只给了 icon+panel，靠 `tappable` 才过）

### 2.5 两个插件的导出结构一样

```js
// 我的 和 local-grill-me 都是
{ name: '...', apply: function }
```
`unwrapExports` 会走 `exports.default ?? exports`，命名导出可用。
**不是导出格式问题。**

---

## 三、已排除的原因（都有证据）

| 怀疑 | 结论 | 证据 |
|---|---|---|
| 清单格式错 | ❌ 排除 | `checkManifest` → `state: "ok"`, `native: true`, `issues: []` |
| cordis.patch.yml 格式错 | ❌ 排除 | 已改成顶层数组 `- insert: [...]` |
| bundle 没登记 | ❌ 排除 | `loadProfile.layers[19] = local-ai-company` |
| 配置没组合进去 | ❌ 排除 | `--dump-config` 输出含 `# == local-ai-company`，230 条 |
| 包解析失败 | ❌ 排除 | `require.resolve` 成功 |
| import 失败 | ❌ 排除 | `import('local-ai-company')` 成功，name/apply 都在 |
| apply 抛错 | ❌ 排除 | 模拟 ctx 调用 apply 不抛错 |
| 引擎没重启 | ❌ 排除 | 15:09:37 重启，晚于插件修改 15:08:46 |
| 被定制模块干扰 | ❌ 排除 | xsdsh-purge-next 只动 hooks 权限，不碰插件 |

---

## 四、剩下的唯一可能

**第 3 关没过：`ctx.dshGo.panel()` 没有注册成功。**

为什么可能？

1. `ctx.inject(['dshGo'], fn)` 的回调**没被调用**
   - 我模拟测试时是手动调用 fn 的，真实环境里如果 dshGo 服务没就绪，fn 可能不执行
2. 插件实例在 `dshGo` 服务就绪**之前**就被创建了（时序问题）
3. 注册时抛错但被吞掉了

**验证方法**：必须在引擎运行时拿到桥接的 `/dsh-go/v1/inventory` 返回，
里面有 `issues` 数组，会明确写 `no-handler`。

---

## 五、怎么拿到需要鉴权的接口数据

引擎所有 HTTP 都要 token（根路径也返回 401）。三条路：

1. **App 里看诊断**：设置 → 诊断 → 发布，读 `evidence` 段
2. **引擎日志**：目前 stdout/stderr 被重定向到 pipe，读不到
3. **临时关掉 route guard**：改 `/etc/dsh-app/dsh-web.patch.yml`，但会影响安全

**推荐第 1 条**，不动配置。

---

## 六、下次做插件前必须做的（写进流程）

1. 先看 `local-grill-me` 这种**已经在用**的插件做参照（同环境已验证可用）
2. 写完立刻 `checkManifest`，必须 `state: "ok"` 且 `issues: []`
3. 写完立刻 `--dump-config`，确认 `# == <插件名>` 出现
4. **`panels` 一律至少给两个 placement**：`session.tab` + `features`（都不需要协商）
5. **`composer.strip` 一定带 `text`**，不要只给 icon
6. 改完 `lib/` 必须重启引擎；改 `package.json` 可以不重启
7. **别猜**。`--dump-config` 一条命令就能看到真相，比猜 6 次快 100 倍

---

## 七、来源

- 本地源码：`/opt/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（profile 加载）
- 本地源码：`/opt/dsh/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js`（插件加载）
- 本地源码：`/opt/dsh-go/dsh-go-bridge/lib/native/manifest.js`（原生清单校验）
- 本地源码：`/opt/dsh-go/dsh-go-bridge/lib/native/core.js`（插件扫描）
- 本地源码：`/opt/dsh-go/dsh-go-bridge/lib/native/limits.js`（placement 常量）
- 本地源码：`/opt/dsh-go/dsh-go-bridge/lib/native/capabilities.js`
- 技能文档：`/root/.dsh/skills/dsh-go-plugin/SKILL.md`
- 模板：`/root/.dsh/skills/dsh-go-plugin/template/`
- 网页：https://dshbase.com/zh/（L1~L4 验证分级方法）
