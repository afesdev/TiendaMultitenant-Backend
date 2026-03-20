-- Agregar columnas de fecha de creación y modificación a Productos (DATETIME2)
-- Ejecutar una sola vez en la base de datos existente.

USE TiendaMultitenant;

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'Productos' AND COLUMN_NAME = 'FechaCreacion'
)
BEGIN
  ALTER TABLE Productos ADD FechaCreacion DATETIME2 NOT NULL DEFAULT SYSDATETIME();
END;

IF NOT EXISTS (
  SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_NAME = 'Productos' AND COLUMN_NAME = 'FechaModificacion'
)
BEGIN
  ALTER TABLE Productos ADD FechaModificacion DATETIME2 NULL;
END;

GO
