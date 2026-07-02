import { Column, Typography, Button } from '@nks/mobile-ui-components';
import { useAuth } from '../../providers/AuthProvider';

export default function HomeScreen() {
  const { logout } = useAuth();

  return (
    <Column flex={1} padding="large" gap="large" justify="center" align="center">
      <Typography.H2>Ayphen Retail POS</Typography.H2>
      <Typography.Body>You're signed in.</Typography.Body>
      <Button label="Log out" variant="default" onPress={logout} accessibilityLabel="Log out" />
    </Column>
  );
}
