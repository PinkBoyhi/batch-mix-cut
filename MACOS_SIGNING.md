# macOS 签名与公证

完成这一次配置后，GitHub 发布的 macOS 安装包会使用 Apple Developer ID 签名并提交公证，其他 Mac 不需要手动清除隔离标记。

## 前置条件

1. Apple Developer Program 会员资格已激活。
2. 在 Apple Developer 的 Certificates 页面创建 `Developer ID Application` 证书，并下载安装到本机钥匙串。
3. 在“钥匙串访问”中导出该证书为 `.p12`，设置一个仅用于导出的密码。
4. Apple ID 已开启双重认证，并在 Apple ID 账户页创建“App 专用密码”。

## GitHub Secrets

仓库 `Settings` -> `Secrets and variables` -> `Actions` 中添加以下 Secrets。不要把证书或密码提交到 Git。

| Secret | 内容 |
| --- | --- |
| `MACOS_CERTIFICATE_P12_BASE64` | `.p12` 文件的 Base64 文本。macOS 可执行 `base64 -i DeveloperIDApplication.p12 | pbcopy` 后粘贴。 |
| `MACOS_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码。 |
| `APPLE_ID` | 用于公证的 Apple ID 邮箱。 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 该 Apple ID 新建的 App 专用密码。 |
| `APPLE_TEAM_ID` | Apple Developer Account 页面显示的 Team ID。 |

## 发布校验

Secrets 配置后，推送下一个 `v*` 标签会自动执行：Developer ID 签名、启用 Hardened Runtime、提交 Apple Notary Service、将公证票据附加到应用、验证签名。

本机可检查发布包中的应用：

```bash
codesign --verify --deep --strict --verbose=2 "/Applications/医博生物混剪工具.app"
spctl -a -vvv -t open "/Applications/医博生物混剪工具.app"
```

当前未签名版本只在已清除隔离标记的本机可正常打开；它不能替代 Developer ID 签名和公证。
