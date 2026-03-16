import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const container = document.getElementById("app");
if (!container) throw new Error("No #app element found");

createRoot(container).render(<App />);
