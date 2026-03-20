-- Agregar columna Variante_Id a Apartados_Detalle para soportar variantes en apartados
USE TiendaMultitenant;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.columns
    WHERE object_id = OBJECT_ID('Apartados_Detalle') AND name = 'Variante_Id'
)
BEGIN
    ALTER TABLE Apartados_Detalle
    ADD Variante_Id INT NULL;

    ALTER TABLE Apartados_Detalle
    ADD CONSTRAINT FK_Detalle_Apartado_Variante FOREIGN KEY (Variante_Id) REFERENCES Producto_Variaciones(Id);
END
GO

