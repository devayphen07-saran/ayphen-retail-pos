import { Column, Typography, Button } from '@ayphen/mobile-ui-components';
import { useAuth } from '@core/providers/AuthProvider';

/** PERSONAL mode — stops here, no store needed (mobile-03 §8D.2). No personal
 *  workspace UI exists yet; placeholder landing point. */
export function PersonalWorkspaceScreen() {
  const { logout } = useAuth();

  return (
    <Column flex={1} padding="large" gap="large" justify="center" align="center">
      <Typography.H2>Personal workspace</Typography.H2>
      <Typography.Body>Coming soon.</Typography.Body>
      <Button label="Log out" variant="default" onPress={logout} accessibilityLabel="Log out" />
    </Column>
  );
}
