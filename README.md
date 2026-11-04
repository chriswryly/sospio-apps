# Sospio apps

Sospio is a resilience harness. (See: [AxR Lab](https://axrlab.net/).) It monitors conversations with an AI assistant for signals of potential problems as they develop, and can inject notices to the user and to the AI assistant with the goal of addressing those signals. This repository includes client-side apps that can be run on the user's device, and connect to the Sospio monitor service.

Choose the [chat app](local/README.md) to chat with an assistant running through Ollama on your Mac, or optionally an assistant hosted through your own OpenRouter account. Choose the [browser app](browser/README.md) to use supported chat websites inside Sospio. For either pathway, you need a monitor access token, which you can request the first time you open the app, with an invite code. To get an invite code if you do not have one, you may request via email from: sospio-code at axrlab dot net.

## Getting started

You need macOS, Node 20, and a Sospio monitor token. Open either app's folder, run `npm install`, then `npm run dev`. Enter your token on the first screen. The default monitor address is `https://monitor.sosp.io`.

The two apps have separate settings and records. Tokens entered in an app are encrypted with Electron's operating-system storage and saved in that app's data folder. Use **Clear monitor token** to remove a saved token. If your Mac cannot provide encrypted storage, the app refuses to save it.

## What leaves your computer

With both apps, the conversation text, including the current user message, assistant reply, and conversation context needed for monitoring, goes to the Sospio monitor server. From there, it may go to other services for processing; as of this writing, Jev is the principal backend which receives messages.

The chat app sends messages to your local Ollama assistant by default. If you enable the hosted assistant, it sends messages through OpenRouter to the chosen model's host using your own account. The browser app connects to the chat website you choose; that website handles your account and conversations under its own terms.

## Records and deletion

Sessions and logs are stored in each app's macOS application-data folder, normally under `~/Library/Application Support/`. Records expire after 14 days without use unless you configure a different retention period. Expiry is checked at launch and hourly while the app runs. You can delete recorded conversations from the Records panel; wait for a running turn to finish before retrying a busy deletion. Deleting local records does not remove copies kept by the monitor server, a chat website, OpenRouter, or a model host. The Records panel explains what the selected app sends and keeps.

## Checks

In each app folder, run `npm run typecheck`, `npm test`, `npm run test:leaks`, and `npm run build`. From this folder, run `node --test tests/release_leak.test.mjs` and `node scripts/check-imports.mjs`. The source scan covers this tree, including tests and lockfiles; installed dependencies and generated build folders are excluded. The import check resolves source imports and rejects paths outside this folder.

Licensed under the Apache License 2.0; see `LICENSE`.

## Releasing

In the public repository, set both app `package.json` versions to the same release version, update both lockfiles,
and commit the changes. Push a matching tag, for example `git tag v0.1.0` followed by `git push origin v0.1.0`.
The release workflow checks the tag against both versions, runs the checks, and builds separate Apple silicon
and Intel `.dmg` and `.zip` installers. It attaches them and `SHA256SUMS.txt` to a **draft** Release. Review the
draft, test the installers, and publish it by hand. A manual workflow run builds downloadable Actions artifacts
without creating or publishing a Release.

No signing secrets are needed for the early ad-hoc signed, unnotarized builds. Certificate signing and notarization
run only when all six repository secrets exist: `APPLE_CERTIFICATE` (a base64-encoded Developer ID `.p12`),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
That switches on hardened runtime and notarization without editing the workflow or builder configuration.
Keep these values in repository secrets, never in the source tree.
