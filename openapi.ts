import type { OpenAPIV3_1 } from 'openapi-types'

export const openapiDocument: OpenAPIV3_1.Document = {
  openapi: '3.1.0',
  info: {
    title: 'Tienda Multitenant API',
    version: '1.0.0',
    description:
      'API para gestión de productos, ventas, clientes, proveedores, repartidores y autenticación en una tienda multitenant.',
  },
  servers: [
    {
      url: 'http://localhost:3001',
      description: 'Servidor local de desarrollo',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
      },
      LoginRequest: {
        type: 'object',
        required: ['email', 'password', 'tiendaSlug'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' },
          tiendaSlug: { type: 'string', description: 'Slug de la tienda (por ejemplo, "mitienda")' },
        },
        example: {
          email: 'admin@mitienda.com',
          password: '123456',
          tiendaSlug: 'mi-tienda',
        },
      },
      Producto: {
        type: 'object',
        properties: {
          Id: { type: 'integer' },
          Nombre: { type: 'string' },
          CodigoInterno: { type: 'string' },
          CodigoBarras: { type: 'string', nullable: true },
          Costo: { type: 'number', format: 'double' },
          PrecioDetal: { type: 'number', format: 'double' },
          PrecioMayor: { type: 'number', format: 'double', nullable: true },
          StockActual: { type: 'integer' },
          Visible: { type: 'boolean' },
          Categoria_Id: { type: 'integer', nullable: true },
          CategoriaNombre: { type: 'string', nullable: true },
          Proveedor_Id: { type: 'integer', nullable: true },
          ProveedorNombre: { type: 'string', nullable: true },
          Descripcion: { type: 'string', nullable: true },
          ImagenUrl: { type: 'string', nullable: true },
          FechaCreacion: { type: 'string', format: 'date-time', nullable: true },
          FechaModificacion: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      CrearProductoRequest: {
        type: 'object',
        required: ['nombre', 'codigoInterno', 'precioDetal'],
        properties: {
          nombre: { type: 'string' },
          codigoInterno: { type: 'string' },
          codigoBarras: { type: 'string', nullable: true },
          proveedorId: { type: 'integer', nullable: true },
          categoriaId: { type: 'integer', nullable: true },
          descripcion: { type: 'string', nullable: true },
          costo: { type: 'number', format: 'double' },
          precioDetal: { type: 'number', format: 'double' },
          precioMayor: { type: 'number', format: 'double', nullable: true },
          stockActual: { type: 'integer' },
          visible: { type: 'boolean' },
        },
        example: {
          nombre: 'Camiseta básica blanca',
          codigoInterno: 'camiseta-basica-blanca-s',
          codigoBarras: '7701234567890',
          proveedorId: 1,
          categoriaId: 2,
          descripcion: 'Camiseta de algodón 100% cuello redondo',
          costo: 15000,
          precioDetal: 29900,
          precioMayor: 25000,
          stockActual: 50,
          visible: true,
        },
      },
      Cliente: {
        type: 'object',
        properties: {
          Id: { type: 'integer' },
          Cedula: { type: 'string' },
          Nombre: { type: 'string' },
          Email: { type: 'string', nullable: true },
          Celular: { type: 'string', nullable: true },
          Direccion: { type: 'string', nullable: true },
          Ciudad: { type: 'string', nullable: true },
          FechaRegistro: { type: 'string', format: 'date-time' },
        },
      },
      CrearClienteRequest: {
        type: 'object',
        required: ['cedula', 'nombre'],
        properties: {
          cedula: { type: 'string' },
          nombre: { type: 'string' },
          email: { type: 'string', format: 'email', nullable: true },
          celular: { type: 'string', nullable: true },
          direccion: { type: 'string', nullable: true },
          ciudad: { type: 'string', nullable: true },
        },
        example: {
          cedula: '1234567890',
          nombre: 'Juan Pérez',
          email: 'juan.perez@example.com',
          celular: '3001234567',
          direccion: 'Calle 123 #45-67',
          ciudad: 'Bogotá',
        },
      },
      Repartidor: {
        type: 'object',
        properties: {
          Id: { type: 'integer' },
          Nombre: { type: 'string' },
          Telefono: { type: 'string' },
          DocumentoIdentidad: { type: 'string', nullable: true },
          Vehiculo: { type: 'string', nullable: true },
          Placa: { type: 'string', nullable: true },
          Disponible: { type: 'boolean' },
          Activo: { type: 'boolean' },
          FechaRegistro: { type: 'string', format: 'date-time' },
        },
      },
      CrearRepartidorRequest: {
        type: 'object',
        required: ['nombre', 'telefono'],
        properties: {
          nombre: { type: 'string' },
          telefono: { type: 'string' },
          documento: { type: 'string', nullable: true },
          vehiculo: { type: 'string', nullable: true },
          placa: { type: 'string', nullable: true },
          disponible: { type: 'boolean' },
          activo: { type: 'boolean' },
        },
        example: {
          nombre: 'Carlos López',
          telefono: '3011234567',
          documento: 'CC 12345678',
          vehiculo: 'Motocicleta',
          placa: 'ABC123',
          disponible: true,
          activo: true,
        },
      },
      VentaItem: {
        type: 'object',
        required: ['productoId', 'cantidad', 'precioUnitario'],
        properties: {
          productoId: { type: 'integer' },
          cantidad: { type: 'integer' },
          precioUnitario: { type: 'number', format: 'double' },
        },
      },
      CrearVentaRequest: {
        type: 'object',
        required: ['clienteId', 'items'],
        properties: {
          clienteId: { type: 'integer' },
          repartidorId: { type: 'integer', nullable: true },
          tipoVenta: {
            type: 'string',
            nullable: true,
            description: 'DETAL | MAYORISTA | APARTADO | CATALOGO',
          },
          tipoEntrega: {
            type: 'string',
            nullable: true,
            description: 'TIENDA | DOMICILIO',
          },
          metodoPago: {
            type: 'string',
            nullable: true,
            description: 'EFECTIVO | TRANSFERENCIA | MIXTO',
          },
          observacion: { type: 'string', nullable: true },
          descuentoTotal: { type: 'number', format: 'double', nullable: true },
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/VentaItem' },
          },
        },
        example: {
          clienteId: 1,
          repartidorId: 2,
          tipoVenta: 'DETAL',
          tipoEntrega: 'DOMICILIO',
          metodoPago: 'EFECTIVO',
          observacion: 'Entregar en portería después de las 6 pm',
          descuentoTotal: 5000,
          items: [
            {
              productoId: 10,
              cantidad: 2,
              precioUnitario: 29900,
            },
            {
              productoId: 11,
              cantidad: 1,
              precioUnitario: 49900,
            },
          ],
        },
      },
      VentaResumen: {
        type: 'object',
        properties: {
          Id: { type: 'integer' },
          Fecha: { type: 'string', format: 'date-time' },
          TipoVenta: { type: 'string', nullable: true },
          TipoEntrega: { type: 'string', nullable: true },
          MetodoPago: { type: 'string', nullable: true },
          Subtotal: { type: 'number', format: 'double' },
          DescuentoTotal: { type: 'number', format: 'double' },
          Total: { type: 'number', format: 'double' },
          Observacion: { type: 'string', nullable: true },
          ClienteId: { type: 'integer' },
          ClienteNombre: { type: 'string' },
          RepartidorId: { type: 'integer', nullable: true },
          RepartidorNombre: { type: 'string', nullable: true },
        },
      },
      Categoria: {
        type: 'object',
        properties: {
          Id: { type: 'integer' },
          Nombre: { type: 'string' },
          Slug: { type: 'string' },
          CategoriaPadre_Id: { type: 'integer', nullable: true },
          Visible: { type: 'boolean' },
        },
      },
      Proveedor: {
        type: 'object',
        properties: {
          Id: { type: 'integer' },
          Nombre: { type: 'string' },
          Contacto: { type: 'string', nullable: true },
          Telefono: { type: 'string', nullable: true },
          Email: { type: 'string', nullable: true },
          Activo: { type: 'boolean' },
        },
      },
    },
  },
  security: [
    {
      bearerAuth: [],
    },
  ],
  paths: {
    '/health': {
      get: {
        summary: 'Estado del backend',
        description: 'Devuelve información básica de estado del servidor.',
        responses: {
          '200': {
            description: 'Servidor en funcionamiento',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    env: { type: 'string', example: 'development' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/auth/login': {
      post: {
        summary: 'Iniciar sesión',
        description:
          'Devuelve un token JWT y la información básica del usuario y de la tienda para autenticarse en el panel.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/LoginRequest',
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Inicio de sesión exitoso',
          },
          '400': {
            description: 'Parámetros faltantes',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '401': {
            description: 'Credenciales inválidas',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/productos': {
      get: {
        summary: 'Listar productos',
        description: 'Obtiene todos los productos de la tienda actual (activos e inactivos).',
        responses: {
          '200': {
            description: 'Lista de productos',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Producto' },
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Crear producto',
        description:
          'Crea un nuevo producto para la tienda autenticada. Después se pueden asociar imágenes y variantes.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CrearProductoRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Producto creado correctamente',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Producto' },
              },
            },
          },
          '400': {
            description: 'Datos incompletos o inválidos',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/ventas': {
      get: {
        summary: 'Listar ventas',
        description: 'Obtiene las ventas de la tienda actual, opcionalmente filtradas por fecha.',
        parameters: [
          {
            name: 'desde',
            in: 'query',
            required: false,
            description: 'Fecha inicial (YYYY-MM-DD)',
            schema: { type: 'string', format: 'date' },
          },
          {
            name: 'hasta',
            in: 'query',
            required: false,
            description: 'Fecha final (YYYY-MM-DD)',
            schema: { type: 'string', format: 'date' },
          },
        ],
        responses: {
          '200': {
            description: 'Lista de ventas',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/VentaResumen' },
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Registrar una nueva venta',
        description: 'Crea una venta con cabecera y múltiples líneas de detalle.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CrearVentaRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Venta creada correctamente',
          },
          '400': {
            description: 'Datos de la venta incompletos o inválidos',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/clientes': {
      get: {
        summary: 'Listar clientes',
        description:
          'Devuelve los clientes de la tienda actual. Se puede filtrar por nombre, cédula o celular mediante el parámetro q.',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: false,
            description: 'Texto de búsqueda (nombre, cédula o celular)',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Lista de clientes',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Cliente' },
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Crear cliente',
        description: 'Crea un nuevo cliente asociado a la tienda actual.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CrearClienteRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Cliente creado',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Cliente' },
              },
            },
          },
          '400': {
            description: 'Datos de cliente incompletos',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '409': {
            description: 'Ya existe un cliente con esa cédula en la tienda',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/repartidores': {
      get: {
        summary: 'Listar repartidores',
        description: 'Lista todos los repartidores de la tienda autenticada.',
        responses: {
          '200': {
            description: 'Lista de repartidores',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Repartidor' },
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Crear repartidor',
        description: 'Registra un nuevo repartidor para la tienda actual.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CrearRepartidorRequest' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Repartidor creado',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Repartidor' },
              },
            },
          },
          '400': {
            description: 'Datos de repartidor incompletos',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
    '/categorias': {
      get: {
        summary: 'Listar categorías',
        description: 'Devuelve las categorías de productos de la tienda actual.',
        responses: {
          '200': {
            description: 'Lista de categorías',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Categoria' },
                },
              },
            },
          },
        },
      },
    },
    '/proveedores': {
      get: {
        summary: 'Listar proveedores',
        description: 'Devuelve los proveedores activos de la tienda actual.',
        responses: {
          '200': {
            description: 'Lista de proveedores',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Proveedor' },
                },
              },
            },
          },
        },
      },
    },
  },
}

