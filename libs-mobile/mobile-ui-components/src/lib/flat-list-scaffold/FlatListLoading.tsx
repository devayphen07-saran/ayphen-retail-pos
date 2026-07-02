import React, { useMemo } from 'react';
import styled from 'styled-components/native';

interface FlatListLoadingProps {
  /**
   * Render function for each skeleton slot. Receives an index so the caller
   * can stagger animations (e.g., shimmer delay = index * 100ms) for a more
   * natural-looking loading state.
   */
  loadingCard: (index: number) => React.ReactNode;
  length?: number;
  scrollEnabled?: boolean;
}

export const FlatListLoading: React.FC<FlatListLoadingProps> = ({
  loadingCard,
  length = 5,
}) => {
  // Stable indices — useMemo so the array reference doesn't change unless
  // `length` changes, preventing unnecessary re-renders of children.
  const indices = useMemo(
    () => Array.from({ length }, (_, i) => i),
    [length],
  );

  return (
    <LoadingWrapper
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      accessibilityState={{ busy: true }}
      accessibilityLiveRegion="polite"
    >
      {indices.map((i) => (
        <CardSlot key={i}>
          {loadingCard(i)}
        </CardSlot>
      ))}
    </LoadingWrapper>
  );
};

// ─── Styles ─────────────────────────────────────────────────────────────

const LoadingWrapper = styled.View`
  padding: ${({ theme }) => theme.padding.xSmall}px;
  flex: 1;
`;

const CardSlot = styled.View`
  margin-bottom: ${({ theme }) => theme.sizing.small}px;
`;
