import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { queryClient } from "./queryClient";
import "./globals.css";
import { startWebsiteRpcTokens } from "./websiteRpcTokens";

const stopWebsiteRpcTokens = startWebsiteRpcTokens();
import.meta.hot?.dispose(stopWebsiteRpcTokens);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
