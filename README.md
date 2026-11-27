# vike

The complete source code of this Whacka app, downloaded on 2026-11-27.
Nothing is taken out: your own files exactly as they are, and the Whacka platform code
the app is built with, the same files Whacka uses when it publishes it.

## What is inside

- `src/`: your app's own code (`src/App.jsx`, pages, components, hooks and the rest).
- `src/lib/`: the Whacka library the app uses for data, sign-in, files, AI, payments,
  push messages and more.
- `src/main.jsx` and `index.html`: how the app starts.
- `package.json`, `package-lock.json`, `vite.config.js`, `tailwind.config.js`,
  `postcss.config.js`: the build setup. `npm ci` then `npm run build` builds it.
- `.env.example`: the settings Whacka's build gives the app.

## Will it run somewhere else?

This code calls Whacka's servers for its data, sign-in, files, AI and payments.
Those servers stop on December 16, 2026, so after that the app will not run as it is.
The complete code, together with your data, is enough for a developer or another AI
tool to rebuild the app on another service.

Your records and stored files are not in this download. To get everything, open the
App tab, then Developer, and choose Download everything.
