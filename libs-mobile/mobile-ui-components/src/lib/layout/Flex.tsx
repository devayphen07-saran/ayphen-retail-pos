import React from "react";
import { ViewProps } from "react-native";
import styled from "styled-components/native";
import { SizeType } from "@nks/mobile-theme";

export type Spacing = keyof SizeType | number;

export interface FlexProps extends ViewProps {
  gap?: Spacing;
  align?: "flex-start" | "flex-end" | "center" | "stretch" | "baseline";
  justify?:
    | "flex-start"
    | "flex-end"
    | "center"
    | "space-between"
    | "space-around"
    | "space-evenly";
  padding?: Spacing;
  margin?: Spacing;
  direction?: "row" | "column";
  wrap?: "wrap" | "nowrap";
  width?: string | number;
  height?: string | number;
  bg?: string;
  radius?: number;
  border?: string;
  flex?: number;
  children?: React.ReactNode;
}

export const StyledFlex: React.FC<FlexProps> = styled.View<FlexProps>`
  display: flex;
  flex-direction: ${({ direction }) => direction || "column"};
  justify-content: ${({ justify }) => justify || "flex-start"};
  align-items: ${({ align }) => align || "stretch"};
  flex-wrap: ${({ wrap }) => wrap || "nowrap"};
  ${(props) => {
    const { flex, gap, padding, margin, width, height, bg, radius, border, theme } = props;
    const styles: Record<string, unknown> = {};

    if (flex !== undefined) styles['flex'] = flex;
    if (gap !== undefined) {
      if (typeof gap === "number") styles['gap'] = gap;
      else if (theme.sizing && gap in theme.sizing)
        styles['gap'] = theme.sizing[gap as keyof SizeType];
    }

    if (padding !== undefined) {
      if (typeof padding === "number") styles['padding'] = padding;
      else if (theme.sizing && padding in theme.sizing)
        styles['padding'] = theme.sizing[padding as keyof SizeType];
    }

    if (margin !== undefined) {
      if (typeof margin === "number") styles['margin'] = margin;
      else if (theme.sizing && margin in theme.sizing)
        styles['margin'] = theme.sizing[margin as keyof SizeType];
    }

    if (width !== undefined) styles['width'] = width;
    if (height !== undefined) styles['height'] = height;

    if (bg) {
      const colorEntry = (theme.color as Record<string, { main?: string } | undefined>)[bg];
      if (colorEntry?.main) styles['backgroundColor'] = colorEntry.main;
      else if (bg in theme) styles['backgroundColor'] = (theme as unknown as Record<string, unknown>)[bg];
      else styles['backgroundColor'] = bg;
    }

    if (radius !== undefined) styles['borderRadius'] = radius;

    if (border) {
      styles['borderWidth'] = 1;
      styles['borderColor'] = theme.colorBorder;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return styles as any;
  }}
`;

export const Flex: React.FC<FlexProps> = StyledFlex;

export const Row: React.FC<FlexProps> = (props) => {
  return <StyledFlex direction="row" {...props} />;
};

export const Column: React.FC<FlexProps> = (props) => {
  return <StyledFlex direction="column" {...props} />;
};
