export const ResponseMessages = {
  auth: {
    login:    'Login successful',
    logout:   'Logged out successfully',
    refresh:  'Token refreshed',
    register: 'Account created successfully',
  },
  products: {
    created: 'Product created successfully',
    updated: 'Product updated successfully',
    deleted: 'Product deleted successfully',
    found:   'Product retrieved successfully',
    list:    'Products retrieved successfully',
  },
  orders: {
    created:   'Order created successfully',
    paid:      'Order payment recorded',
    cancelled: 'Order cancelled',
    refunded:  'Order refunded',
    found:     'Order retrieved successfully',
    list:      'Orders retrieved successfully',
  },
  lookups: {
    created: 'Lookup created successfully',
    updated: 'Lookup updated successfully',
    deleted: 'Lookup deleted successfully',
    list:    'Lookups retrieved successfully',
  },
  users: {
    created: 'User created successfully',
    updated: 'User updated successfully',
    deleted: 'User deleted successfully',
    found:   'User retrieved successfully',
    list:    'Users retrieved successfully',
  },
} as const;