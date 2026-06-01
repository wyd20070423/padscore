# 发布到 GitHub Pages

仓库建议：

- GitHub 用户：`wyd20070423`
- 仓库名：`padscore`
- Pages 地址：`https://wyd20070423.github.io/padscore/`

这个仓库只放谱库程序外壳，不放你的谱子。你的 PDF 和图片会在 iPad 上导入，并保存在 iPad 本地浏览器数据库里。

## 手动上传

1. 打开 GitHub，新建公开仓库 `padscore`。
2. 上传 `padscore-pages` 文件夹里的所有内容到仓库根目录。
3. 进入仓库 `Settings` -> `Pages`。
4. Source 选择 `Deploy from a branch`。
5. Branch 选择 `main`，目录选择 `/root`。
6. 等 GitHub Pages 构建完成后，用 iPad Safari 打开：

   ```text
   https://wyd20070423.github.io/padscore/?v=7
   ```

7. 点 Safari 分享按钮，选择“添加到主屏幕”。
8. 第一次打开时保持联网，等页面完整加载一次。之后已导入的谱子可以离线打开。

## 重要提醒

Safari 本地数据库不是永久保险柜。请定期在应用里点“导出备份”，把 zip 保存到 iCloud Drive 或“文件”App。
