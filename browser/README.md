# Sospio Browser

This app opens ChatGPT or Claude in a separate browser window and shows the Sospio monitor beside it. Use your own account on those websites.

Conversation actions run by default, so monitor readings can lead to notices or other actions. For testing, set `RSH_BROWSER_GOVERNOR_LOOP=0` to keep monitoring while turning those actions off.

## Install and run

You need macOS, Node.js 20 or later, npm, an internet connection, and a Sospio monitor token.

From this folder, run:

```sh
npm install
npm run dev
```

On first run, enter your monitor token. The default monitor URL is `https://monitor.sosp.io`. Your token is encrypted with macOS storage protection through Electron and stored in the app's data folder. If encryption is unavailable, the app refuses to save the token. Use **Clear monitor token** to remove it.

For testing, `RSH_MONITOR_REMOTE_URL` and `RSH_MONITOR_REMOTE_TOKEN` override saved settings. An HTTP URL is accepted only for a local fixture server on `127.0.0.1` or `localhost`. A token is always required. Clearing the token also clears the override for this running app; remove it from your launch environment before restarting.

Completed user messages and assistant replies, conversation identifiers, provider names and timestamps go to the Sospio monitor server. Monitoring starts after you configure a token. Records and logs stay under the app's macOS Application Support folder and expire after 14 days unless `RSH_RECORDS_RETENTION_DAYS` changes that period. **Delete my data** removes local records. Server records follow the monitor service's retention policy.

## Troubleshooting

- **401 or unauthorized:** check the token. After five failed sign-ins, the monitor server can block sign-ins from your network address for 15 minutes. Wait 15 minutes before trying again. Restarting the app does not clear the block; the server operator can clear it by restarting the relay.
- **Monitor unavailable:** check the connection and monitor URL, then choose **Restart Monitor**. A failed connection does not produce a clear reading.
- **A chat site will not open:** sign in to your own ChatGPT or Claude account in the app's chat window and reload it.
- **Ollama model pull:** this browser app uses the chat websites and needs no local model. Model setup belongs to the local app.

Run `npm run typecheck`, `npm test`, `npm run test:leaks`, and `npm run build` for offline checks. These checks use fixtures and do not call the monitor service or chat providers.

## Download

Download the latest **Sospio Browser** `.dmg` from [Releases](https://github.com/chriswryly/sospio-apps/releases).
Choose `Sospio-Browser-<version>-arm64.dmg` for Apple silicon (M-series Macs), or
`Sospio-Browser-<version>-x64.dmg` for Intel. Open the disk image and drag **Sospio Browser** to Applications.
The installed app requires macOS 13 (Ventura) or later. It does not need Node, git, or Ollama.

This is an early test release, so the app is unsigned and not notarized. Open it once, then, if macOS blocks it,
go to **System Settings › Privacy & Security › Open Anyway**. If macOS says the app is damaged, run this one-time
command in Terminal, then open the app again:

```sh
xattr -dr com.apple.quarantine "/Applications/Sospio Browser.app"
```

Enter an invite code to get a monitor token, or paste a token you already have, then sign in to your own chat-site account.
