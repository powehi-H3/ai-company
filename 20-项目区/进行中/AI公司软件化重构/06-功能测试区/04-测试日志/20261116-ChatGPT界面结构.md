# ChatGPT 适配器 · 测试记录

- 时间：2026-11-16 14:10~14:16
- 包名：`com.openai.chatgpt`
- 启动 Activity：`com.openai.chatgpt.MainActivity`
- **当前等级：L3（单点成功，未稳定）**

---

## 一、界面结构（从董事长截图确认）

**董事长提供的截图（2026-11-16 14:11:55）显示真实界面：**

```
┌────────────────────────────────┐
│  ☰        ✨ 获取 Plus      💬 │  ← 顶栏
├────────────────────────────────┤
│                                │
│          （空白对话区）        │
│                                │
├────────────────────────────────┤
│  ＋  询问 ChatGPT    🎤   🔵  │  ← 输入栏
└────────────────────────────────┘
      ↓ 键盘弹出
┌────────────────────────────────┐
│  拼音键盘…                     │
└────────────────────────────────┘
```

**关键元素**：

| 元素 | 文字/特征 | 位置 |
|---|---|---|
| 输入框 | 占位文字「询问 ChatGPT」 | 屏幕下部，y≈1130/1536 |
| 加号按钮 | ＋ | 输入框左侧 |
| 语音按钮 | 🎤 | 输入框右侧 |
| **发送/语音切换** | 🔵 蓝色圆形 | **最右侧** |
| 顶栏菜单 | ☰ | 左上 |

### ★ 重要发现：发送按钮是「蓝色圆形」

**注意**：截图里那个蓝色圆形按钮是**语音输入**，不是发送。
**ChatGPT 的行为是**：输入框有文字时，语音按钮会变成**发送按钮**（↑ 箭头）。

**这意味着**：适配器不能硬编码按钮位置，**必须判断「有文字后按钮变成什么」**。

---

## 二、dump 实测数据

### 测试 1：启动后 4 秒 dump

```
时间：14:11
元素总数：110
可编辑元素：0 个
有文字的元素：只有 1 个「获取 Plus」
```

**结论**：**加载未完成**。此时界面还是空壳。

### 对比：DSH 自己的界面

```
元素总数：4,410
```

**差了 40 倍。** 说明 ChatGPT 那个 110 元素的界面确实还没渲染完。

---

## 三、问题：为什么 dump 不到输入框

| 可能原因 | 判断 |
|---|---|
| 加载太慢 | ✅ **最可能** —— 只等了 4 秒 |
| 输入框不是 `editable=true` | ⚠️ 可能，Flutter/Compose 应用常见 |
| 需要滚动才渲染 | ⚠️ 可能 |
| uiautomator 权限不足 | ❌ 不太可能（能抓到 110 个元素） |

### 验证方法（下一步要做）

**方案 A：轮询等待**

```sh
for i in $(seq 1 20); do
  uiautomator dump /sdcard/gpt.xml
  if grep -q "询问 ChatGPT" /sdcard/gpt.xml; then
    echo "加载完成（第 $i 次）"; break
  fi
  sleep 1
done
```

**方案 B：直接找输入框的语义特征**

ChatGPT 输入框的占位文字是「询问 ChatGPT」。
即使 `editable` 不是 true，**文字内容也在 XML 里**。

**这是更稳的做法**：按**文字**找，不按 `class` 或 `editable` 找。

---

## 四、待做的测试

| # | 测试 | 目的 | 等级目标 |
|---|---|---|---|
| T1 | 轮询 dump 直到出现「询问 ChatGPT」 | 确认加载完成需要多久 | L3 |
| T2 | 找到输入框后 `input tap` 点它 | 确认能聚焦 | L3 |
| T3 | `input text "测试"` | 确认能打字 | L3 |
| T4 | dump 确认文字已进去 | 确认输入成功 | L3 |
| T5 | 找发送按钮并点击 | 确认能发送 | L3 |
| T6 | 连续做 10 次 | 确认稳定 | **L4** |

**T1~T5 全过 = L3；T6 过 = L4（能说「可用」）。**

---

## 五、适配器设计草案

```python
class ChatGPTAdapter:
    pkg = "com.openai.chatgpt"
    launch = "com.openai.chatgpt.MainActivity"
    
    # 语义特征，不硬编码 id
    INPUT_HINT = "询问 ChatGPT"      # 输入框占位文字
    SEND_MARKERS = ["发送", "Send"]   # 发送按钮可能的文字
    
    def wait_for_input(self, timeout=30):
        """轮询 dump 直到找到输入框"""
        for i in range(timeout):
            xml = dump_ui()
            node = find_node_with_text(xml, self.INPUT_HINT)
            if node:
                return node.center()
            sleep(1)
        raise TimeoutError("输入框未出现")
    
    def send(self, text):
        x, y = self.wait_for_input()
        run(f"input tap {x} {y}")
        sleep(0.5)
        run(f"input text {shell_quote(text)}")
        sleep(0.5)
        xml = dump_ui()
        # 校验文字确实进去了
        assert text[:10] in xml, "文字没进去"
        # 找发送按钮
        btn = find_send_button(xml)
        run(f"input tap {btn[0]} {btn[1]}")
```

**核心原则**：
1. **按文字找，不按 id 找** —— App 更新也不容易坏
2. **每步都校验** —— 打完字要确认进去了
3. **超时要有上限** —— 不能无限等

---

## 六、当前结论

| 项 | 状态 |
|---|---|
| 能启动 ChatGPT | ✅ **L3**（实测有截图证据） |
| 能读前台包名 | ✅ **L3** |
| 能 dump 界面 | ✅ **L2**（抓到过 110 元素） |
| 能找到输入框 | ❌ **未成功**（加载未完成） |
| 能打字 | ❌ 未测 |
| 能发送 | ❌ 未测 |
| **整体** | **L1 → 需要继续测** |

**不能声称「ChatGPT 自动投递可用」。**
