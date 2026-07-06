import { Column, Row, SkeletonBox } from '@ayphen/mobile-ui-components';
import { useMobileTheme } from '@ayphen/mobile-theme';

/** Layout-matched loading state: intro copy + resource sections (subtitle + a
 *  few keep/lock rows with a checkbox), so real content swaps in without a jump. */
export function DowngradeResolveLoading() {
  const { theme } = useMobileTheme();
  return (
    <Column gap={16}>
      {/* Intro copy */}
      <Column gap={6}>
        <SkeletonBox width="100%" height={11} />
        <SkeletonBox width="90%" height={11} />
        <SkeletonBox width="70%" height={11} />
      </Column>

      {/* Resource sections (stores / locations / devices) */}
      {[0, 1].map((s) => (
        <Column key={s} gap={8}>
          <SkeletonBox width={160} height={16} />
          <Column gap={8}>
            {[0, 1, 2].map((i) => (
              <Row key={i} align="center" justify="space-between" style={{ paddingVertical: theme.sizing.small }}>
                <Column flex={1} gap={4}>
                  <SkeletonBox width={140} height={13} />
                  <SkeletonBox width={110} height={10} />
                </Column>
                <SkeletonBox width={18} height={18} borderRadius={theme.borderRadius.regular} />
              </Row>
            ))}
          </Column>
        </Column>
      ))}
    </Column>
  );
}