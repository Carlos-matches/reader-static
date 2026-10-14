<div align="center">

# 📖 本地阅读器 · 纯静态

**部署到 Netlify　·　书籍和进度全部存在浏览器里　·　不需要任何服务器**

> 📌 **部署请用「Import from Git」**，不要用本页的 Deploy 按钮。
> 原因见 👉 [部署章节](#-部署到-netlify)

</div>

---

## 这是什么

一个**纯静态**的电子书阅读器：

- 📚 导入 TXT / EPUB，存在浏览器 IndexedDB 里
- 📖 阅读界面、字号调节、进度自动保存
- 🔍 通过 Netlify 函数转发来搜书源（绕过浏览器跨域限制）
- 💾 支持导出/导入备份
- 🚀 部署到 Netlify，**零服务器、零费用、无需信用卡**

**和「阅读3服务器版」的区别**：那个需要一台常驻服务器；这个不需要，
代价是数据只存在你自己的浏览器里。

---

## ⚠️ 先读：你必须知道的取舍

### 数据只在这个浏览器里

| 情况 | 结果 |
|---|---|
| 清除浏览器数据 | ❌ **全部丢失** |
| 换手机 / 换电脑 | ❌ 看不到原来的书 |
| 重装系统 | ❌ 全部丢失 |
| Safari 7 天不访问 | ⚠️ 可能被自动清理 |
| 浏览器认为磁盘紧张 | ⚠️ 可能被清理 |

**所以：请定期用「设置 → 导出备份」保存一份到本地。**

程序启动时会申请「持久化存储」权限，获得后浏览器**不会**自动清理数据
（但仍会因你手动清除而丢失）。

### 其他限制

- ❌ 没有多设备同步（数据在各自浏览器里）
- ❌ 没有账号系统
- ⚠️ 书源搜索依赖 Netlify 函数转发，**部分书源可能仍失败**（书源本身失效是常态）
- ⚠️ 浏览器存储上限通常是磁盘剩余空间的一定比例，放几千本 TXT 没问题，大量 PDF/漫画要留意

---

## 🚀 部署到 Netlify

### 方式一：Import from Git（推荐 ✅）

在 Netlify 里**直接连接**这个仓库，以后每次推送都会自动重新部署。

1. 打开 <https://app.netlify.com/start> 登录后，点
   **「Import from Git」**（不是页面上的 Deploy 按钮）
2. 选 **GitHub** → 授权 → 选择 `reader-static`
3. 构建设置保持默认（`netlify.toml` 已写好，无需改动）
4. 点 **Deploy site**

> ⚠️ **不要用 README 顶部的「Deploy to Netlify」按钮！**
>
> 那个按钮会**复制**一份仓库，命名为 `reader-static-xxxxx`（随机后缀），
> 它是**快照副本，不会跟着原仓库更新**。你之后在原仓库修的任何问题，
> 那个副本都收不到 —— 会一直构建旧的、有问题的代码。
>
> 如果出现一个名字带随机后缀的仓库，说明你点到那个按钮了，
> 删掉站点重新用「Import from Git」即可。

### 方式二：命令行

```bash
npm install
npm run build
npx netlify-cli deploy --prod --dir=dist
```

### 方式三：拖拽（不用 Git）

```bash
npm install && npm run build
```

然后把 `dist` 文件夹拖到 <https://app.netlify.com/drop>。

> ⚠️ 拖拽方式**不会部署代理函数**，书源搜索会不可用。
> 想要搜索功能请用方式一或二。

---

## 💻 本地开发

```bash
npm install
npm run dev        # 打开 http://localhost:5173
```

本地开发时书源代理走 vite 的 proxy（见 `vite.config.ts`）。

---

## 📖 使用方法

### 1. 导入书籍

打开首页 → **点击选择文件** 或把 TXT/EPUB **拖进虚线框**。

支持一次拖多本。导入后会自动读取 EPUB 的标题、作者和封面。

> 💡 **中文 TXT 的编码问题**：很多中文电子书是 GBK 编码。
> 程序会自动检测：先按 UTF-8 解，如果出现大量乱码就自动改用 GBK。

### 2. 阅读

点书架上的书即可打开。底部工具栏可调字号、回到顶部。
**滚动时进度会自动保存**，下次打开回到原处。

### 3. 配置书源（搜书用）

进入 **书源** 页 → 粘贴书源 JSON → 添加 → **勾选启用**。

支持两种格式：

**本项目简洁格式**：
```json
[
  {
    "name": "我的书源",
    "searchUrl": "https://xxx.com/api.php/provide/vod/?ac=videolist&wd={keyword}"
  }
]
```

**legado / 阅读 导出格式**（自动识别 `bookSourceName`/`bookSourceUrl` 字段）：
直接粘贴从阅读 App 导出的书源 JSON 即可。

> 📌 **书源去哪找**：在 GitHub 搜索 `阅读3.0 书源` / `legado 书源` / `shuyuan`。
> 书源失效是常态，**多导入几个备用**。

### 4. 备份（重要）

**设置 → 导出备份** 会下载一个 JSON 文件（包含全部书籍和进度）。

换设备时：新设备打开 → 设置 → **导入备份** → 选择该文件。

---

## 🏗 实现说明

### 为什么数据能存在浏览器里

浏览器提供了 **IndexedDB** —— 一个可以存几百 MB 到几 GB 的本地数据库：

| 存储 | 用途 | 实现 |
|---|---|---|
| `kv` | 书架、进度、书源、设置 | `src/storage.ts` |
| `blobs` | 书籍文件本体（二进制） | `src/storage.ts` |

> 为什么不用 localStorage：它只有约 5MB，且只能存字符串，
> 存二进制要转 base64（体积涨 33%）。IndexedDB 没有这些问题。

### 为什么还需要一个 Netlify 函数

浏览器有**同源策略**：网页直接请求第三方书源网站会被 CORS 拦截，
因为那些网站不会返回 `Access-Control-Allow-Origin` 头。

```
浏览器 ──请求──▶ /api/proxy?url=...     （同源，允许）
                      │
                      ▼
                Netlify 函数           （服务器，不受同源策略限制）
                      │
                      ▼
                  书源网站  ──数据──▶ 原路返回
```

**这个函数是无状态的**：它不保存任何数据，只做转发。
所以它不构成"服务器"，Netlify 免费额度完全够用。

> 这也是 [MoonTV](https://github.com/samqin123/MoonTV) 能在 Netlify 上跑的原因。

### 代理的安全限制

开放代理有被滥用成攻击跳板的风险，所以做了限制：

| 限制 | 原因 |
|---|---|
| 只允许 GET | 避免被用作提交接口 |
| 只允许 http/https | 阻止 `file://` 读本地文件 |
| **拒绝内网地址** | 防止 SSRF 读取云厂商元数据（`169.254.169.254` 等） |
| 响应上限 5MB | 防止被大文件拖垮 |
| 超时 15 秒 | 同上 |

内网拦截覆盖：`10/8`、`172.16/12`、`192.168/16`、`127/8`、`169.254/16`、
`100.64/10`、`::1`、`fc00::/7`、`fe80::/10`、`localhost` 及其子域。

---

## 🧪 测试

```bash
npm test
```

三个测试文件，共 **39 项检查**：

| 测试 | 内容 | 项数 |
|---|---|---|
| `test/proxy-guard.cjs` | SSRF 拦截/放行判定（从源码提取真实实现） | 20 |
| `test/proxy-handler.cjs` | 代理函数的转发、错误码、CORS、超时 | 8 |
| `test/e2e.cjs` | **真实 Chrome 浏览器**跑 IndexedDB、导入、进度 | 11 |

`e2e` 测试用 Chrome headless + CDP 驱动，真正验证：
打开页面 → 导入 TXT → 检查 IndexedDB → 验证书名/格式/正文 → 读写进度。

---

## 📁 项目结构

```
.
├── src/
│   ├── main.ts         # 界面与交互
│   ├── storage.ts      # IndexedDB 封装 + 备份导出/导入
│   ├── library.ts      # 书籍导入、EPUB/TXT 解析、进度
│   ├── sources.ts      # 书源管理与搜索
│   └── style.css
├── netlify/functions/
│   └── proxy.ts        # CORS 代理（含 SSRF 防护）
├── test/               # 三个测试文件
├── netlify.toml        # 部署配置
└── index.html
```

体积：应用 JS 仅 **9.4 KB**（gzip），加上 jszip 共约 40 KB。

---

## ❓ 常见问题

<details>
<summary><b>数据真的不会丢吗？</b></summary>

**会丢。** 请务必理解这一点：

- 浏览器是"可能被清理"的存储，不是永久存储
- 清除浏览器数据、换设备、重装系统都会导致数据丢失
- 程序会申请持久化权限降低被自动清理的概率，但**不能保证**

**唯一的保障是定期导出备份。** 建议每周导出一次。
</details>

<details>
<summary><b>能在手机上用吗？</b></summary>

可以。用手机浏览器打开 Netlify 地址即可。

iPhone：Safari → 分享 → **添加到主屏幕**，用起来和 App 一样。

⚠️ 但注意：**手机和电脑的书架是各自独立的**，不会同步。
换手机需要用导出的备份文件恢复。
</details>

<details>
<summary><b>为什么搜不到书？</b></summary>

按顺序检查：

1. **书源启用了吗？** 书源页需要**勾选**才会参与搜索
2. **书源失效了？** 这是最常见的。换个书源试试
3. **部署方式对了吗？** 用拖拽上传的话没有代理函数，搜索必然失败
   → 改用 Git 导入或命令行部署
4. **代理报错？** 打开浏览器 F12 控制台看具体错误

书源搜索依赖第三方网站，**不保证每个都能用**。
</details>

<details>
<summary><b>支持 PDF / MOBI / AZW3 吗？</b></summary>

**不支持**，目前只支持 TXT 和 EPUB。

PDF 可以用浏览器直接打开；MOBI/AZW3 需要用 Calibre 转成 EPUB。
</details>

<details>
<summary><b>书籍有大小限制吗？</b></summary>

单个文件建议不超过 50MB。

超大文件（如整本扫描漫画）导入时会占用大量内存解析。
浏览器总存储上限通常是磁盘剩余空间的 60% 左右，一般够放几千本 TXT。
</details>

<details>
<summary><b>这和「阅读3服务器版」比少了什么？</b></summary>

| 功能 | 本方案 | 阅读3服务器版 |
|---|---|---|
| 导入本地书 | ✅ | ✅ |
| 阅读/进度 | ✅ | ✅ |
| 书源搜索 | ⚠️ 部分可用 | ✅ |
| 多设备同步 | ❌ | ✅ |
| 多用户 | ❌ | ✅ |
| 手机 App 接入 | ❌ | ✅ |
| 需要服务器 | ✅ **不需要** | ❌ 需要 |

如果你需要多设备同步或手机 App 接入，请看
[reader-free-deploy](https://github.com/Carlos-matches/reader-free-deploy)。
</details>

---

## 📄 许可

MIT

## 🙏 致谢

- 书源格式兼容 [阅读（legado）](https://github.com/gedoor/legado) 生态
- 架构思路参考 [MoonTV](https://github.com/samqin123/MoonTV)（纯静态 + 代理 + 外部存储）
- EPUB 解析使用 [JSZip](https://stuk.github.io/jszip/)
