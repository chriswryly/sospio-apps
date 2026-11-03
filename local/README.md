# Sospio chat

Use this app to chat with a local Ollama assistant while Sospio monitors the conversation through the Sospio monitor server. Your messages, the assistant's replies and the assistant context go to that server. The assistant also receives the messages it needs to answer.

## Install and open

You need macOS, Node 20 or later, npm, and Ollama. Install and start Ollama, then pull an assistant model:

```sh
ollama pull llama3.2:3b
```

In this folder, run:

```sh
npm install
npm run dev
```

On a computer with at least 18 GB of memory the default assistant is `llama3.1:8b`; otherwise it is `llama3.2:3b`. Pull the model shown in the app, or choose one with `RSH_LOCAL_CHAT_MODEL=llama3.2:3b npm run dev`.

## Connect the monitor

The first screen says “Enter your Sospio monitor token.” Enter your token and keep the default server address, `https://monitor.sosp.io`, unless you have been given another address. The app stores the token using macOS secure storage. Use **Clear monitor token** to remove it and return to the first screen.

Testers can override the saved connection with `RSH_MONITOR_REMOTE_URL` and `RSH_MONITOR_REMOTE_TOKEN`. A local fixture server may use HTTP on `127.0.0.1` or `localhost`; other servers require HTTPS. Do not put tokens in source files or shell scripts.

Conversation records stay in this app's application data folder, with a 14 day retention period unless configured otherwise. Open **Your data** to see what is stored, export the conversation, or use **Delete recorded conversations**. Deleting local records does not delete copies already sent to the monitor server or an assistant provider.

## Optional hosted assistant

The app can use your own OpenRouter account instead of Ollama for the assistant. Set `RSH_LOCAL_HOSTED_ASSISTANT=1` and `RSH_LOCAL_ASSISTANT_OPENROUTER_API_KEY` before starting the app. Your chosen provider receives the chat messages. The default spending cap is $1 per launch; `RSH_LOCAL_ASSISTANT_CAP_USD` can lower it. Choose the assistant before sending the first message; it stays fixed for that conversation.

For a different local Ollama address, set `RSH_LOCAL_OLLAMA_URL`. Use **Restart** after starting Ollama or pulling a missing model.

## Troubleshooting

- **HTTP 401 or unauthorized:** check the token. After five failed sign-ins, the monitor server can block sign-ins from your network address for 15 minutes. Wait 15 minutes before trying again. Restarting the app does not clear the block; the server operator can clear it by restarting the relay.
- **Monitor unavailable:** check your network and server address, then choose **Reconnect**. The app shows unavailable status while a connection fails.
- **Ollama is not reachable:** start Ollama and choose **Restart**.
- **Pull required models:** run the `ollama pull` command shown in the app, then choose **Restart**.
- **Secure storage is unavailable:** unlock your macOS login keychain and reopen the app. The app does not save the token as plain text.

For offline checks, run `npm run typecheck`, `npm test`, `npm run test:leaks`, and `npm run build`.
