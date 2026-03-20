-- Vincular movimientos de devolución a una venta (para validar cantidades devueltas)
USE TiendaMultitenant;
GO

IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('Movimientos_Inventario') AND name = 'Venta_Id'
)
BEGIN
    ALTER TABLE Movimientos_Inventario
    ADD Venta_Id INT NULL;

    ALTER TABLE Movimientos_Inventario
    ADD CONSTRAINT FK_Movs_Venta FOREIGN KEY (Venta_Id) REFERENCES Ventas(Id);
END
GO
