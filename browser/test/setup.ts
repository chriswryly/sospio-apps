import { vi } from "vitest";

vi.mock("electron", () => ({ipcMain: {on: vi.fn(), once: vi.fn(), handle: vi.fn(), removeListener: vi.fn(), removeHandler: vi.fn()}}));
