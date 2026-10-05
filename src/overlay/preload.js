// Preload окна оверлея. Работает в sandbox: доступны только contextBridge и ipcRenderer.
// Наружу отдаём ровно два метода, сам ipcRenderer странице не виден.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("floatingChats", {
    onUpdate(cb) {
        ipcRenderer.on("floating-chats:update", (_e, state) => cb(state));
    },
    send(action) {
        ipcRenderer.send("floating-chats:action", action);
    }
});
