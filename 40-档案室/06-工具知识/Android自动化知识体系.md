# Android 自动化知识体系（学习笔记）

- 学习时间：2026-11-16 14:40
- 学习人：DSH
- 起因：我写的 `aidrop.sh` 用 `input` 命令，撞了三个坑（找不到输入框、坐标会变、中文不支持）
- **目的：先搞清这个领域成熟做法，别再自己瞎试**
- 资料来源：GitHub API 实测拉取（搜索服务不可用，直接读仓库）

---

## 零、一句话总纲

> **Android 自动化的成熟方案，不靠 `input` 命令，靠「无障碍服务 + 元素选择器 + 隐式等待」。**
>
> `input` 命令是最原始、最不稳定的那一档。我一开始选错档位了。

---

## 一、四个技术档次（从差到好）

| 档 | 技术 | 稳定性 | 我用的 |
|---|---|---|---|
| **1** | `input tap/text` 命令 | ⭐ 最差 | ✅ **我用的这个** |
| **2** | `uiautomator dump` + 解析 XML + `input` | ⭐⭐ | ✅ **我加到这档** |
| **3** | 无障碍服务（AccessibilityService） | ⭐⭐⭐⭐ | ❌ |
| **4** | 设备端 HTTP 服务（uiautomator2 架构） | ⭐⭐⭐⭐⭐ | ❌ |

### 各档的问题

**档 1：`input` 命令**
- 只能发原始触摸/键盘事件
- 不知道界面状态，坐标必须自己算
- 中文直接崩（`Exception occurred while executing 'text'`）
- **没有任何等待机制**

**档 2：dump + input**
- 能知道界面，但仍靠坐标点击
- 坐标会随布局变化（实测：输入框从 y=1506 变到 y=2390）
- 仍要自己写轮询

**档 3：无障碍服务**
- 能直接操作控件对象，不需要坐标
- 有系统级的事件回调
- 需要写一个 Android App

**档 4：设备端 HTTP 服务**（业界主流）
- 设备上跑一个服务，PC/脚本通过 HTTP 调它
- 元素定位、等待、输入全由服务端实现
- **最稳定，支持多设备**

---

## 二、业界标杆：uiautomator2 的架构（必须学）

**项目**：`openatx/uiautomator2`（Python 生态事实标准）

### 2.1 架构（摘自官方 README）

> The framework mainly consists of two parts:
> 1. **Device Side**: Runs an HTTP service based on UiAutomator, providing various interfaces
> 2. **Python Client**: Communicates with device side via HTTP protocol

```
Python 客户端  ←── HTTP ──→  设备端服务（jar）  ←──→  UiAutomator（系统 API）
```

**为什么这么设计**：
- Python 那边写代码简单直观
- 设备端服务常驻，不用每次启动
- 走 HTTP 而不是每次起一个 `input` 进程

**对我们的启示**：我们现在是「每条命令起一个 `input` 进程」，
uiautomator2 是「服务常驻 + HTTP 调用」。**根本设计差异。**

### 2.2 元素定位：XPath（不是坐标！）

```python
d.xpath('//*[@text="私人FM"]').click()      # 按文字找
d.xpath('@personal-fm')                      # 按 resource-id 找（语法糖）
sl = d.xpath("@com.example:id/home_searchedit")
sl.click(timeout=10)                         # 带超时的点击
sl.click_exists(timeout=10)                  # 存在才点，返回是否成功
```

**关键：按「元素特征」找，不按「坐标」找。**

我犯的错就是算坐标 —— 布局一变就全废。

### 2.3 输入：自动降级策略（解决中文的关键）

```python
d.send_keys("Hello123abcEFG")                # 发文字
d.send_keys("Hello123abcEFG", clear=True)    # 先清空再发
d.clear_text()                               # 清空
d.send_action()                              # 自动按回车/搜索
```

**官方文档原文（最重要的一句）**：

> When `send_keys` is used, it **prioritizes using the clipboard** for input.
> **If the clipboard interface is unavailable, it will attempt to install and use an auxiliary IME.**

**这就是标准解法**：
1. 先试剪贴板（能解决任何字符，包括中文、emoji）
2. 剪贴板不行 → 装一个辅助输入法

```python
print(d.current_ime())   # 查当前输入法
```

### 2.4 隐式等待（解决「加载慢」的关键）

```python
d.implicitly_wait(10.0)                      # 设置元素查找等待时间
d.settings['wait_timeout'] = 10.0            # 另一种写法

d(text="Settings").click()                   # 10 秒内没出现就抛异常
```

**这是最优雅的设计**：把「等待」内建到元素查找里。

**我犯的错**：写死 `sleep 4`，然后 dump。加载没完就报「找不到」。
正确做法：**等待元素出现，不是等待固定时间**。

---

## 三、FIRERPA/lamda 的架构（国产标杆，8,744★）

**项目**：`firerpa/lamda`

### 3.1 它对标什么（README 原文）

> Compared with **stitching together Appium, mitmproxy, frida-server, adb, uiautomator2, and ad-hoc scripts**,
> FIRERPA offers **one source of capabilities, unified configuration, connected workflows**,
> and a stack built for **multi-device, long-running, production use**.

**它把 Appium + mitmproxy + frida + adb + uiautomator2 全整合了。**

### 3.2 核心设计点（可直接借鉴）

| 设计 | 说明 | 对我们的价值 |
|---|---|---|
| **Server 跑在设备上，无额外依赖** | 不用装 Python、不用装 Appium | ⭐⭐⭐ 我们也是手机本地 |
| **有 root 模式和免 root 模式** | 我们走 root 模式 | ⭐⭐⭐ |
| **选择器系统** | text / resourceId / description / scrollable + **child/sibling 链式** | ⭐⭐⭐ 解决重复元素、深层嵌套 |
| **UI Watcher** | 实时监听界面变化，条件满足自动执行 | ⭐⭐ 可自动关广告/弹窗 |
| **Virtual Display** | 在虚拟屏上跑自动化，**不占用主屏** | ⭐⭐⭐ 可隔离自动化屏幕，不干扰主屏 |
| **OCR + 图像匹配** | 没有控件树也能操作（游戏/自绘 UI） | ⭐ 备选 |
| **元素级等待** | wait for appear / disappear | ⭐⭐⭐ |

### ★★★ 关键发现：Virtual Display

**README 原文**：

> **Virtual Display** is a differentiator: create isolated background displays on the device
> and run apps and automation there **without affecting the main screen** — e.g.,
> auto-reply on a virtual display while you use the phone normally.

**这可隔离自动化与主屏操作，避免互相干扰。**

自动化在主屏操作目标 App 时，界面可能被切走（如用户手动切回 DSH、来电、弹窗等）。
如果在**虚拟屏**上跑目标 App，主屏不受影响，两者互不干扰。

**这条必须验证。**

---

## 四、Krosxx/Android-Auto-Api（国产无障碍框架，654★）

### 4.1 它解决的问题

> 安卓无障碍服务 Api，为了简化无障碍服务使用，使用 Kotlin 提供简洁的 Api。

### 4.2 核心 API（比对我们的做法）

| 能力 | 它的做法 | 我们的做法 |
|---|---|---|
| 基础导航 | `back()` / `home()` / `recents()` / `quickSettings()` | `input keyevent` |
| 提取文字 | `ScreenTextFinder().find()` 一次拿全屏文字 | grep XML |
| 视图搜索 | `ViewFinder` / `SmartFinder`（多条件 AND/OR） | 自己写 grep |
| **等待元素** | `waitFor(waitMillis = 30000)` **循环搜索直到出现** | ❌ 我写死 sleep |
| 立即搜索 | `findFirst()` / `findAll()` | grep |
| 要求存在 | `require(...)` 不存在就抛异常 | ❌ |

### 4.3 它强调的一条纪律

READM 原文：

> **操作之间需要适当延时等待**

```kotlin
toast("下拉通知栏..")
delay(1000)        // ← 每个操作后都 delay
quickSettings()
delay(1000)
back()
```

**这是基础纪律：操作之间要有间隔。** 我的脚本里 delay 太少。

---

## 五、我犯的错 vs 成熟做法（逐条对照）

| # | 我的做法 | 成熟做法 | 为什么我的错 |
|---|---|---|---|
| 1 | `input tap (x,y)` 按坐标点 | **按元素特征找**（text/id/desc） | 坐标随布局变化，实测 1506→2390 |
| 2 | 写死 `sleep 4` | **`implicitly_wait` / `waitFor`** | 加载时间不定，4 秒可能不够 |
| 3 | 用 `mCurrentFocus` 判前台 | **用 `topResumedActivity`** | mCurrentFocus 会骗人（我误判 3 次） |
| 4 | `input text "中文"` | **剪贴板 → 辅助 IME 降级** | input text 不支持非 ASCII |
| 5 | 每次起一个 `input` 进程 | **服务常驻 + HTTP/RPC** | 进程开销大、无法保持状态 |
| 6 | 操作之间无延迟 | **每步 `delay(500~1000)`** | 系统渲染跟不上 |
| 7 | 主屏操作别的 App 会被切走 | **虚拟屏（Virtual Display）** | 隔离自动化屏幕 |
| 8 | 自己 grep XML 找元素 | **XPath / 选择器** | 重复元素、深层嵌套难处理 |

---

## 六、修正后的技术路线

### 现在用的（档 2）
`uiautomator dump` + grep + `input tap` —— 能用但不稳

### 应该升级到（档 3 或 4）

| 方案 | 工作量 | 收益 |
|---|---|---|
| **A. 装 ADBKeyBoard**（辅助 IME） | 小（18KB APK） | **解决中文输入** |
| **B. 引入 uiautomator2** | 中（要装 Python 包 + 设备端 jar） | 完整能力（选择器/等待/输入） |
| **C. 自己做虚拟屏** | 大 | 隔离自动化与主屏 |
| **D. 用 lamda** | 中（它有 MCP 接口） | 一步到位，但要学它的 API |

### 我的建议顺序

1. **先解决中文**（A：ADBKeyBoard，18KB，最小代价）
2. **再解决等待**（改成 `waitFor` 思路，不用 sleep）
3. **再考虑架构升级**（B 或 D）
4. **虚拟屏放最后**（C，工作量最大但最有价值）

---

## 七、关键概念速查

| 概念 | 含义 | 怎么用 |
|---|---|---|
| **隐式等待** | 设置全局「找元素最多等多久」 | `implicitly_wait(10)` |
| **显式等待** | 针对某个元素单独等 | `waitFor(30000)` / `click(timeout=10)` |
| **XPath** | 用路径表达式定位元素 | `//*[@text="xx"]` |
| **resource-id** | 控件的唯一 id | `@com.example:id/xxx` |
| **content-desc** | 无障碍描述（中文 App 常用） | 千问发送按钮就是这个 |
| **UI Watcher** | 监听界面变化自动处理 | 自动关广告 |
| **Virtual Display** | 虚拟屏，不占主屏 | 后台跑自动化 |
| **辅助 IME** | 一个专门用来接收文字注入的输入法 | ADBKeyBoard |

---

## 八、读过的项目清单（供以后查）

| 项目 | Star | 学什么 |
|---|---|---|
| `openatx/uiautomator2` | — | **架构（设备端服务+HTTP）、XPath、隐式等待、send_keys 降级** |
| `firerpa/lamda` | 8,744 | **Virtual Display、UI Watcher、选择器链式、生产级设计** |
| `Krosxx/Android-Auto-Api` | 654 | 无障碍 API 封装、waitFor、多条件搜索 |
| `appium/appium` | 22,223 | 行业标准（跨平台，但重） |
| `appium/appium-uiautomator2-server` | 415 | Appium 的 Android 后端 |
| `senzhk/ADBKeyBoard` | **1,991** | **中文输入的标准解法（辅助 IME + base64 广播）** |
| `Core-Mate/OpenGUI` | 1,811 | Android GUI agent 框架 |

---

## 九、一句话总结

> **我之前把「能跑通一次」当成了「能做」。**
>
> **成熟方案早就解决了：坐标会变（用选择器）、加载会慢（用隐式等待）、中文打不进去（用剪贴板/辅助 IME）、界面被切走（用虚拟屏隔离）。**
>
> **我一个都没用，全在重新发明轮子，而且还是最差的那个版本。**


---

## 九、Compose 自绘 App 的输入框定位（2026-11-16 实测教训）

**DeepSeek 等 Compose App 的输入框，uiautomator 抓不到语义信息。**

实测：
- 输入框是 `android.view.View`（不是 EditText）
- 无 hint、无 content-desc、无 text
- 唯一特征是「屏幕底部 + 宽度 > 50%」的 View

**结论：**
1. 传统 App（千问/ChatGPT）→ 用 EditText/hint 语义定位
2. Compose App（DeepSeek）→ 只能按坐标定位（底部宽 View）
3. 每个 App 必须有**自己的输入框定位适配器**，不能一套通吃

**另一个坑（已修正）：**
- ~~monkey 启动后 DSH 抢前台~~ ← **误判，董事长澄清：是手动返回 DSH 看进度**
- 真正的问题：脚本结束后界面一直停在目标 App，没有「返回 DSH」的收尾
- **修复：脚本 trap 退出时自动 `am start` 切回 DSH**


---

## 十、UI 验证的三大陷阱（2026-11-16 实测总结）

**陷阱 1：mCurrentFocus 会误导**
- 显示的可能不是真正前台，必须用 topResumedActivity

**陷阱 2：topResumedActivity 也可能误导**
- App 启动后可能被其他 App 抢走前台（如 DSH 悬浮窗）
- dump 到的 UI 可能是别的 App 的，必须校验 dump XML 里的 package

**陷阱 3：uiautomator XML 看不到 Compose 输入框的内容**
- Compose 自绘输入框的 text 属性恒为空
- XML grep 不到文字 ≠ 文字没进去
- **验证 Compose 输入框内容必须用截图（screencap）**

### 三层验证法（最终结论）

| 验证什么 | 用什么 |
|---|---|
| 前台是哪个 App | topResumedActivity |
| dump 抓的是谁 | XML 的 package 字段 |
| Compose 输入框有没有文字 | **截图**（XML 不可信） |

### 实测过的输入方式结论

| 方式 | 传统 EditText | Compose 输入框 |
|---|---|---|
| input text | ✅ | ✅（截图证实） |
| ADBKeyBoard 广播 | ✅ | ✅（截图证实） |

**两种注入方式对 Compose 都生效。**


---

## 十一、第四条 UI 验证陷阱（2026-11-16 董事长澄清）

**陷阱 4：共享屏幕下，「前台是谁」的观察可能被用户动作污染**

- 我（跑在 DSH 里的 AI）测试操控别的 App 时，跟用户共享同一个屏幕
- 用户随时可能切回 DSH 看进度、回消息、点悬浮窗
- 我却把「用户手动切回」误判成了「DSH 自动抢焦点」

**教训**：
1. 测试「操控别的 App」时，前台状态的变化，要先问「是不是用户手动操作」
2. 不能只凭「dump 抓到别的 App」就断定有 bug，要排除用户操作干扰
3. 「DSH 打开别的软件后不会自动关闭返回」是**真问题**，解法是脚本收尾时 trap 切回 DSH

**这才是真正的通用教训**，比单个结论（am start vs monkey）重要得多。
