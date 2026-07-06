import { Column, Row, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** Layout-matched loading state for InviteStaffScreen — method toggle + contact
 *  field + role/location selectors, shown while roles & locations load (§2). */
export function InviteStaffLoading() {
  const { theme } = useMobileTheme();

  const field = (labelWidth: number) => (
    <Column gap={8}>
      <SkeletonBox width={labelWidth} height={12} />
      <SkeletonBox width="100%" height={48} borderRadius={theme.borderRadius.medium} />
    </Column>
  );

  return (
    <Column gap={20}>
      {/* Method segmented toggle (phone / email) */}
      <SkeletonBox width="100%" height={44} borderRadius={999} />
      {field(70)}
      {field(50)}
      {field(120)}
      {/* Selected-location chips */}
      <Row gap={8}>
        {[0, 1, 2].map((i) => (
          <SkeletonBox key={i} width={84} height={28} borderRadius={999} />
        ))}
      </Row>
    </Column>
  );
}