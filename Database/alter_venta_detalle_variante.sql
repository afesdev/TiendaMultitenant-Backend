-- Agregar columna para guardar la variante seleccionada en cada línea de venta
IF COL_LENGTH('Venta_Detalle', 'Variante_Id') IS NULL
BEGIN
    ALTER TABLE Venta_Detalle
    ADD Variante_Id INT NULL;
END
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.foreign_keys
    WHERE name = 'FK_Detalle_Variante'
      AND parent_object_id = OBJECT_ID('Venta_Detalle')
)
BEGIN
    ALTER TABLE Venta_Detalle
    ADD CONSTRAINT FK_Detalle_Variante
        FOREIGN KEY (Variante_Id) REFERENCES Producto_Variaciones(Id);
END
GO

