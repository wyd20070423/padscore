# iPad 谱库

这是一个 iPad 优先的本地谱库 PWA，用来保存、分类、搜索、阅读和批注 PDF/JPG/JPEG/PNG 谱子。

## 使用方式

1. 在电脑上启动本地服务：

   ```powershell
   npm.cmd --prefix E:\lenovo\UserFiles\Documents\music run dev
   ```

2. iPad 和电脑连同一个 Wi-Fi。
3. 在电脑上查看局域网地址，或用 `ipconfig` 找到电脑 IPv4 地址。
4. iPad Safari 打开：

   ```text
   http://电脑IPv4地址:4173/
   ```

5. Safari 分享按钮里选择“添加到主屏幕”。

## 数据安全

谱子、目录、页码顺序和手写批注会保存在 iPad 浏览器本地数据库里。为了长期安全，请定期点“导出备份”，把生成的 zip 保存到 iCloud Drive 或“文件”App。

备份包包含：

- 谱库目录和曲目信息
- 原始 PDF/图片文件
- 页码重排顺序
- 每一页的手写批注图层

恢复时点“恢复备份”，选择之前导出的 zip。

## 已支持

- 任意多级目录
- iPad 本地批量导入 PDF/JPG/JPEG/PNG
- 曲名/文件名搜索
- PDF 和图片看谱
- 横屏自动双页，竖屏单页，也可以手动切换
- 笔记模式手写批注
- 演奏模式只读翻页
- 页码拖拽、前移、后移、删除
- 追加文件到已有曲目
- 完整备份和恢复
