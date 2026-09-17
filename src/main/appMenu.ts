import { Menu, type MenuItemConstructorOptions } from "electron";

import type { ScreenCaptureGate } from "./screenCapture.ts";

/**
 * The application menu.
 *
 * Electron supplies a reasonable default menu when none is set, and this
 * existed only to add one item. Replacing the default means restating the
 * standard items, so they are all `role`s: Electron fills in the labels,
 * shortcuts and behaviour, and they stay correct as Electron changes.
 */
export function buildAppMenu(options: {
  appName: string;
  capture: ScreenCaptureGate;
  onToggleCapture: () => void;
}): Menu {
  const { appName, capture, onToggleCapture } = options;
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: "appMenu" }] as MenuItemConstructorOptions[])
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          // Checkbox rather than a label that flips, so the state is visible
          // without having to remember what the last click did.
          id: "allow-screen-capture",
          label: capture.menuLabel,
          type: "checkbox",
          checked: capture.isAllowed,
          click: onToggleCapture,
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];

  // The app menu's first item is named after the app, and Electron takes that
  // name from the bundle. Passing it explicitly keeps dev builds honest.
  if (isMac && template[0] && typeof template[0] === "object") {
    (template[0] as MenuItemConstructorOptions).label = appName;
  }

  return Menu.buildFromTemplate(template);
}
