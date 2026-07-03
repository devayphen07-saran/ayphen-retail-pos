import React from "react";
import { View } from "react-native";
import { useTheme } from "styled-components/native";
import { SkeletonLoader } from "../SkeletonLoader";

interface Props {
  rows?: number;
}

/** Standard loading state for sheet content — wraps SkeletonLoader with sheet padding. */
export function SheetSkeleton({ rows = 3 }: Props) {
  const theme = useTheme();
  return (
    <View style={{ padding: theme.sizing.medium }}>
      <SkeletonLoader rows={rows} />
    </View>
  );
}
