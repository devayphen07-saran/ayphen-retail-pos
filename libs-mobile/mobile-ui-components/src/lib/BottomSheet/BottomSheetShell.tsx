import React from "react";
import { SingleSnapShell } from "./SingleSnapShell";
import { MultiSnapShell } from "./MultiSnapShell";
import type { BottomSheetConfig } from "./types";

interface Props {
  config: BottomSheetConfig;
  configRef: React.RefObject<BottomSheetConfig | null>;
  onAnimatedClose: () => void;
}

export function BottomSheetShell({ config, configRef, onAnimatedClose }: Props) {
  const Shell = config.multiSnap ? MultiSnapShell : SingleSnapShell;
  return <Shell config={config} configRef={configRef} onAnimatedClose={onAnimatedClose} />;
}
