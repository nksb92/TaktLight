import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installGlobalErrorHandlers } from "./lib/errorReporting";
import { installTestBridge } from "./lib/testBridge";
import { useTaktStore } from "./store/useTaktStore";
import "./index.css";

if (import.meta.env.DEV) {
  installTestBridge();
}

installGlobalErrorHandlers((message) => {
  useTaktStore.setState({ patchToast: message });
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
