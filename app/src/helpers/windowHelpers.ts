import {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  dialog,
  HeadersReceivedResponse,
  IpcMainEvent,
  MessageBoxReturnValue,
  OnHeadersReceivedListenerDetails,
} from 'electron';

import log from 'loglevel';
import path from 'path';
import { getCSSToInject, isOSX, nativeTabsSupported } from './helpers';

const ZOOM_INTERVAL = 0.1;

export function adjustWindowZoom(adjustment: number): void {
  withFocusedWindow((focusedWindow: BrowserWindow) => {
    focusedWindow.webContents.zoomFactor =
      focusedWindow.webContents.zoomFactor + adjustment;
  });
}

export function blockExternalURL(url: string): Promise<MessageBoxReturnValue> {
  return new Promise((resolve, reject) => {
    withFocusedWindow((focusedWindow) => {
      dialog
        .showMessageBox(focusedWindow, {
          message: `Cannot navigate to external URL: ${url}`,
          type: 'error',
          title: 'Navigation blocked',
        })
        .then((result) => resolve(result))
        .catch((err) => {
          reject(err);
        });
    });
  });
}

export async function clearAppData(window: BrowserWindow): Promise<void> {
  const response = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Yes', 'Cancel'],
    defaultId: 1,
    title: 'Clear cache confirmation',
    message:
      'This will clear all data (cookies, local storage etc) from this app. Are you sure you wish to proceed?',
  });

  if (response.response !== 0) {
    return;
  }
  await clearCache(window);
}

export async function clearCache(window: BrowserWindow): Promise<void> {
  const { session } = window.webContents;
  await session.clearStorageData();
  await session.clearCache();
}

export function createAboutBlankWindow(
  options,
  setupWindow: (...args) => void,
  parent?: BrowserWindow,
): BrowserWindow {
  const window = createNewWindow(options, setupWindow, 'about:blank', parent);
  window.hide();
  window.webContents.once('did-stop-loading', () => {
    if (window.webContents.getURL() === 'about:blank') {
      window.close();
    } else {
      window.show();
    }
  });
  return window;
}

export function createNewTab(
  options,
  setupWindow,
  url: string,
  foreground: boolean,
  parent?: BrowserWindow,
): Promise<BrowserWindow> {
  log.debug('createNewTab', { url, foreground, parent });
  return withFocusedWindow((focusedWindow) => {
    const newTab = createNewWindow(options, setupWindow, url, parent);
    focusedWindow.addTabbedWindow(newTab);
    if (!foreground) {
      focusedWindow.focus();
    }
    return newTab;
  });
}

export function createNewWindow(
  options,
  setupWindow: (...args) => void,
  url: string,
  parent?: BrowserWindow,
): BrowserWindow {
  log.debug('createNewWindow', { url, parent });
  const window = new BrowserWindow({
    parent,
    ...getDefaultWindowOptions(options),
  });
  setupWindow(options, window);
  window.loadURL(url).catch((err) => log.error('window.loadURL ERROR', err));
  return window;
}

export function getCurrentURL(): string {
  return withFocusedWindow((focusedWindow) =>
    focusedWindow.webContents.getURL(),
  ) as unknown as string;
}

export function getDefaultWindowOptions(
  options,
): BrowserWindowConstructorOptions {
  const browserwindowOptions: BrowserWindowConstructorOptions = {
    ...options.browserwindowOptions,
  };
  // We're going to remove this and merge it separately into DEFAULT_WINDOW_OPTIONS.webPreferences
  // Otherwise the browserwindowOptions.webPreferences object will completely replace the
  // webPreferences specified in the DEFAULT_WINDOW_OPTIONS with itself
  delete browserwindowOptions.webPreferences;

  const webPreferences = {
    ...(options.browserwindowOptions?.webPreferences ?? {}),
  };

  const defaultOptions: BrowserWindowConstructorOptions = {
    fullscreenable: true,
    tabbingIdentifier: nativeTabsSupported() ? options.name : undefined,
    title: options.name,
    webPreferences: {
      javascript: true,
      nodeIntegration: false, // `true` is *insecure*, and cause trouble with messenger.com
      preload: path.join(__dirname, 'preload.js'),
      plugins: true,
      webSecurity: !options.insecure,
      zoomFactor: options.zoom,
      ...webPreferences,
    },
    ...browserwindowOptions,
  };

  log.debug('getDefaultWindowOptions', {
    options,
    webPreferences,
    defaultOptions,
  });

  return defaultOptions;
}

export function goBack(): void {
  log.debug('onGoBack');
  withFocusedWindow((focusedWindow) => {
    focusedWindow.webContents.goBack();
  });
}

export function goForward(): void {
  log.debug('onGoForward');
  withFocusedWindow((focusedWindow) => {
    focusedWindow.webContents.goForward();
  });
}

export function goToURL(url: string): Promise<void> {
  return withFocusedWindow((focusedWindow) => focusedWindow.loadURL(url));
}

export function hideWindow(
  window: BrowserWindow,
  event: IpcMainEvent,
  fastQuit: boolean,
  tray,
): void {
  if (isOSX() && !fastQuit) {
    // this is called when exiting from clicking the cross button on the window
    event.preventDefault();
    window.hide();
  } else if (!fastQuit && tray) {
    event.preventDefault();
    window.hide();
  }
  // will close the window on other platforms
}

export function injectCSS(browserWindow: BrowserWindow): void {
  const cssToInject = getCSSToInject();

  if (!cssToInject) {
    return;
  }

  browserWindow.webContents.on('did-navigate', () => {
    log.debug(
      'browserWindow.webContents.did-navigate',
      browserWindow.webContents.getURL(),
    );
    // We must inject css early enough; so onHeadersReceived is a good place.
    // Will run multiple times, see `did-finish-load` event on the window
    // that unsets this handler.
    browserWindow.webContents.session.webRequest.onHeadersReceived(
      { urls: [] }, // Pass an empty filter list; null will not match _any_ urls
      (
        details: OnHeadersReceivedListenerDetails,
        callback: (headersReceivedResponse: HeadersReceivedResponse) => void,
      ) => {
        injectCSSIntoResponse(details, cssToInject)
          .then((responseHeaders) => {
            callback({
              cancel: false,
              responseHeaders,
            });
          })
          .catch((err) => {
            log.error('injectCSSIntoResponse ERROR', err);
            callback({
              cancel: false,
              responseHeaders: details.responseHeaders,
            });
          });
      },
    );
  });
}

async function injectCSSIntoResponse(
  details: OnHeadersReceivedListenerDetails,
  cssToInject: string,
): Promise<Record<string, string[]>> {
  // We go with a denylist rather than a whitelist (e.g. only GET/html)
  // to avoid "whoops I didn't think this should have been CSS-injected" cases
  const nonInjectableMethods = ['DELETE', 'OPTIONS'];
  const nonInjectableResourceTypes = ['image', 'script', 'stylesheet', 'xhr'];

  if (
    nonInjectableMethods.includes(details.method) ||
    nonInjectableResourceTypes.includes(details.resourceType) ||
    !details.webContents
  ) {
    log.debug(
      `Skipping CSS injection for:\n${details.url}\nwith method ${details.method} and resourceType ${details.resourceType} and content-type ${details.responseHeaders['content-type']}`,
    );
    return details.responseHeaders;
  }

  log.debug('browserWindow.webContents.session.webRequest.onHeadersReceived', {
    details,
    contentType: details.responseHeaders['content-type'],
  });
  await details.webContents.insertCSS(cssToInject);

  return details.responseHeaders;
}

export function sendParamsOnDidFinishLoad(
  options,
  window: BrowserWindow,
): void {
  window.webContents.on('did-finish-load', () => {
    log.debug(
      'sendParamsOnDidFinishLoad.window.webContents.did-finish-load',
      window.webContents.getURL(),
    );
    // In children windows too: Restore pinch-to-zoom, disabled by default in recent Electron.
    // See https://github.com/nativefier/nativefier/issues/379#issuecomment-598612128
    // and https://github.com/electron/electron/pull/12679
    window.webContents
      .setVisualZoomLevelLimits(1, 3)
      .catch((err) => log.error('webContents.setVisualZoomLevelLimits', err));

    window.webContents.send('params', JSON.stringify(options));
  });
}

export function setProxyRules(window: BrowserWindow, proxyRules): void {
  window.webContents.session
    .setProxy({
      proxyRules,
      pacScript: '',
      proxyBypassRules: '',
    })
    .catch((err) => log.error('session.setProxy ERROR', err));
}

export function withFocusedWindow(block: (window: BrowserWindow) => any): any {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (focusedWindow) {
    return block(focusedWindow);
  }

  return null;
}

export function zoomOut(): void {
  log.debug('zoomOut');
  adjustWindowZoom(-ZOOM_INTERVAL);
}

export function zoomReset(options): void {
  log.debug('zoomReset');
  withFocusedWindow((focusedWindow) => {
    focusedWindow.webContents.zoomFactor = options.zoom;
  });
}

export function zoomIn(): void {
  log.debug('zoomIn');
  adjustWindowZoom(ZOOM_INTERVAL);
}
