// index.js (en tu carpeta /functions)
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");
const { jsPDF } = require("jspdf");
require("jspdf-autotable");
const axios = require("axios");
const { getStorage } = require("firebase-admin/storage");
const { PDFDocument, rgb, StandardFonts } = require("pdf-lib"); // <-- Nueva librería para dibujar

admin.initializeApp();
const db = admin.firestore();

// Configurar SendGrid
const SENDGRID_API_KEY = functions.config().sendgrid.key;
const FROM_EMAIL = functions.config().sendgrid.from_email;
sgMail.setApiKey(SENDGRID_API_KEY);

// --- NUEVO: Configuración de WhatsApp ---
const WHATSAPP_TOKEN = functions.config().whatsapp.token;
const WHATSAPP_PHONE_NUMBER_ID = functions.config().whatsapp.phone_number_id;

const BUCKET_NAME = "importadorave-7d1a0.firebasestorage.app";


// **** INICIO DE LA NUEVA FUNCIÓN ****
/**
 * Se activa cuando un nuevo usuario se crea en Firebase Authentication.
 * Revisa si es el primer usuario y, si es así, le asigna el rol de 'admin' y lo activa.
 */
exports.onUserCreate = functions.auth.user().onCreate(async (user) => {
    const usersCollection = admin.firestore().collection("users");

    // Revisa cuántos documentos hay en la colección de usuarios.
    const snapshot = await usersCollection.limit(2).get();

    // Si solo hay 1 documento (el que se acaba de crear en el app.js), es el primer usuario.
    if (snapshot.size === 1) {
        functions.logger.log(`Asignando rol de 'admin' y estado 'active' al primer usuario: ${user.uid}`);
        // Actualiza el documento del usuario para cambiar su rol y estado.
        return usersCollection.doc(user.uid).update({
            role: "admin",
            status: "active",
            "permissions.facturacion": true,
            "permissions.clientes": true,
            "permissions.items": true,
            "permissions.colores": true,
            "permissions.gastos": true,
            "permissions.proveedores": true,
            "permissions.empleados": true,
        });
    }

    functions.logger.log(`El nuevo usuario ${user.uid} se ha registrado con rol 'planta' y estado 'pending'.`);
    return null; // No hace nada para los siguientes usuarios.
});

/**
 * Formatea un número como moneda colombiana (COP).
 * @param {number} value El valor numérico a formatear.
 * @return {string} El valor formateado como moneda.
 */
function formatCurrency(value) {
    return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        minimumFractionDigits: 0,
    }).format(value || 0);
}

// Función HTTP que devuelve la configuración de Firebase del lado del cliente.
exports.getFirebaseConfig = functions.https.onRequest((request, response) => {
    // Usamos cors para permitir que tu página web llame a esta función.
    cors(request, response, () => {
        // Verifica que la configuración exista antes de enviarla.
        if (!functions.config().prisma) {
            return response.status(500).json({
                error: "La configuración de Firebase no está definida en el servidor.",
            });
        }
        // Envía la configuración como una respuesta JSON.
        return response.status(200).json(functions.config().prisma);
    });
});

/**
 * --- NUEVO: Formatea un número de teléfono de Colombia al formato E.164. ---
 * @param {string} phone El número de teléfono.
 * @return {string|null} El número formateado o null si es inválido.
 */
function formatColombianPhone(phone) {
    if (!phone || typeof phone !== "string") {
        return null;
    }
    let cleanPhone = phone.replace(/[\s-()]/g, "");
    if (cleanPhone.startsWith("57")) {
        return cleanPhone;
    }
    if (cleanPhone.length === 10) {
        return `57${cleanPhone}`;
    }
    return null;
}

/**
 * --- VERSIÓN CORREGIDA Y ROBUSTA ---
 * Envía un mensaje de plantilla de WhatsApp con un documento.
 * AÑADIDO: .trim() para limpiar espacios en blanco en las variables de texto.
 * @param {string} toPhoneNumber Número del destinatario en formato E.164.
 * @param {string} customerName Nombre del cliente para la plantilla.
 * @param {string} remisionNumber Número de la remisión.
 * @param {string} status Estado actual de la remisión.
 * @param {string} pdfUrl URL pública del PDF a enviar.
 * @return {Promise<object>} La respuesta de la API de Meta.
 */
async function sendWhatsAppRemision(toPhoneNumber, customerName, remisionNumber, status, pdfUrl) {
    const formattedPhone = formatColombianPhone(toPhoneNumber);
    if (!formattedPhone) {
        throw new Error(`Número de teléfono inválido o no proporcionado: ${toPhoneNumber}`);
    }

    const API_VERSION = "v19.0";
    const url = `https://graph.facebook.com/${API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

    // Nos aseguramos de que todos los parámetros sean strings para evitar errores de tipo.
    const payload = {
        messaging_product: "whatsapp",
        to: formattedPhone,
        type: "template",
        template: {
            name: "envio_remision",
            language: { code: "es" },
            components: [
                {
                    type: "header",
                    parameters: [{
                        type: "document",
                        document: {
                            link: pdfUrl,
                            filename: `Remision-${String(remisionNumber)}.pdf`,
                        },
                    }],
                },
                {
                    type: "body",
                    parameters: [
                        { type: "text", text: String(customerName) },
                        { type: "text", text: String(remisionNumber) },
                        { type: "text", text: String(status) },
                    ],
                },
            ],
        },
    };

    const headers = {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
    };

    // --- BLOQUE DE DEPURACIÓN ---
    // Este bloque intentará enviar el mensaje y, si falla,
    // registrará la respuesta de error completa de WhatsApp.
    try {
        const response = await axios.post(url, payload, { headers });
        return response;
    } catch (error) {
        if (error.response) {
            // Si hay una respuesta de error del servidor de WhatsApp, la registramos.
            console.error("WhatsApp API Error Detallado:", JSON.stringify(error.response.data, null, 2));
        }
        // Lanzamos un error más informativo.
        throw new Error(`Falló el envío de WhatsApp a ${toPhoneNumber}: ${error.message}`);
    }
}

/**
 * Función para generar un PDF de la remisión.
 * @param {object} remision El objeto con los datos de la remisión.
 * @param {boolean} isForPlanta Indica si el PDF es para el rol de planta.
 * @return {Buffer} El PDF como un buffer de datos.
 */
function generarPDF(remision, isForPlanta = false) {
    const doc = new jsPDF();

    doc.setFontSize(20);
    doc.setFont("helvetica", "bold");
    doc.text("REMISION DE SERVICIO", 105, 20, { align: "center" });

    // Marca de agua "ANULADA"
    if (remision.estado === "Anulada") {
        doc.setFontSize(60);
        doc.setTextColor(255, 0, 0);
        doc.text("ANULADA", 105, 140, null, 45);
        doc.setTextColor(0, 0, 0);
    }

    doc.setFontSize(10);
    doc.setFont("helvetica", "bold");
    doc.text("IMPORTADORA VIDRIOS EXITO", 105, 28, { align: "center" });
    doc.setFont("helvetica", "normal");
    const contactInfo = "Tels: 310 2557543 – 313 2522810";
    const address = "Cra 27A No. 68-80";
    doc.text(contactInfo, 105, 33, { align: "center" });
    doc.text(address, 105, 38, { align: "center" });

    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    const remisionNum = `Remisión N°: ${remision.numeroRemision}`;
    doc.text(remisionNum, 190, 45, { align: "right" });

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.text("Cliente:", 20, 55);
    doc.setFont("helvetica", "normal");
    doc.text(remision.clienteNombre, 40, 55);
    if (!isForPlanta) {
        doc.setFont("helvetica", "bold");
        doc.text("Correo:", 20, 61);
        doc.setFont("helvetica", "normal");
        doc.text(remision.clienteEmail, 40, 61);
    }


    doc.setFont("helvetica", "bold");
    doc.text("Fecha Recibido:", 130, 55);
    doc.setFont("helvetica", "normal");
    doc.text(remision.fechaRecibido, 165, 55);

    doc.setFont("helvetica", "bold");
    doc.text("Fecha Entrega:", 130, 61);
    doc.setFont("helvetica", "normal");
    doc.text(remision.fechaEntrega || "Pendiente", 165, 61);

    let tableColumn = ["Referencia", "Descripción", "Cant."];
    if (!isForPlanta) {
        tableColumn.push("Vlr. Unit.", "Subtotal");
    }

    const tableRows = remision.items.map((item) => {
        // Se elimina item.color de la fila
        const row = [item.referencia, item.descripcion, item.cantidad];
        if (!isForPlanta) {
            row.push(formatCurrency(item.valorUnitario), formatCurrency(item.cantidad * item.valorUnitario));
        }
        return row;
    });

    doc.autoTable({
        head: [tableColumn],
        body: tableRows,
        startY: 75,
        theme: "grid",
        headStyles: { fillColor: [22, 160, 133] },
    });

    const finalY = doc.lastAutoTable.finalY;
    let yPos = finalY + 10;

    if (remision.incluyeIVA && !isForPlanta) {
        doc.setFontSize(9);
        doc.setFont("helvetica", "italic");
        doc.setTextColor(100); // Color gris
        doc.text("Nota: El valor del IVA (19%) se liquidará en la factura final.", 20, yPos);
        doc.setTextColor(0); // Restablecer color a negro
        yPos += 7;
    }

    if (!isForPlanta) {
        doc.setFontSize(12);
        doc.setFont("helvetica", "bold");
        doc.text("Subtotal:", 130, yPos);
        doc.setFont("helvetica", "normal");
        doc.text(formatCurrency(remision.subtotal), 190, yPos, { align: "right" });
        yPos += 7;

        if (remision.discount && remision.discount.amount > 0) {
            doc.setFont("helvetica", "bold");
            doc.text("Descuento:", 130, yPos);
            doc.setFont("helvetica", "normal");
            doc.text(`-${formatCurrency(remision.discount.amount)}`, 190, yPos, { align: "right" });
            yPos += 7;
        }

        if (remision.incluyeIVA) {
            doc.setFont("helvetica", "bold");
            doc.text("IVA (19%):", 130, yPos);
            doc.setFont("helvetica", "normal");
            doc.text(formatCurrency(remision.valorIVA), 190, yPos, { align: "right" });
            yPos += 7;
        }

        doc.setFont("helvetica", "bold");
        doc.text("TOTAL:", 130, yPos);
        doc.text(formatCurrency(remision.valorTotal), 190, yPos, { align: "right" });
        yPos += 11;

        doc.setFontSize(10);
        doc.text(`Forma de Pago: ${remision.formaPago}`, 20, yPos);
        yPos += 7;
        doc.text(`Estado: ${remision.estado}`, 20, yPos);
    }

    // Signature Line
    yPos = 250;
    doc.line(40, yPos, 120, yPos);
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text("Firma y Sello de Recibido", 75, yPos + 5, { align: "center" });

    doc.setLineCap(2);
    doc.line(20, 270, 190, 270);
    const footerText1 = "NO SE ENTREGA TRABAJO SINO HA SIDO CANCELADO.";
    const footerText2 = "DESPUES DE 8 DIAS NO SE RESPONDE POR MERCANCIA.";
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.text(footerText1, 105, 275, { align: "center" });
    doc.text(footerText2, 105, 279, { align: "center" });

    return Buffer.from(doc.output("arraybuffer"));
}

// AGREGA ESTA NUEVA FUNCIÓN
exports.getSignedUrlForPath = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "El usuario no está autenticado.");
    }
    const filePath = data.path;
    if (!filePath) {
        throw new functions.https.HttpsError("invalid-argument", "La ruta del archivo es requerida.");
    }

    try {
        const bucket = getStorage().bucket(BUCKET_NAME);
        const file = bucket.file(filePath);
        const [url] = await file.getSignedUrl({
            action: "read",
            expires: Date.now() + 15 * 60 * 1000, // La URL expira en 15 minutos
        });
        return { url: url };
    } catch (error) {
        functions.logger.error(`Error al generar URL para ${filePath}:`, error);
        throw new functions.https.HttpsError("internal", "No se pudo obtener la URL del archivo.");
    }
});

exports.onRemisionCreate = functions.region("us-central1").firestore
    .document("remisiones/{remisionId}")
    .onCreate(async (snap, context) => {
        sgMail.setApiKey(functions.config().sendgrid.key);
        const FROM_EMAIL = functions.config().sendgrid.from_email;
        const remisionData = snap.data();
        const remisionId = context.params.remisionId;
        const log = (message) => functions.logger.log(`[${remisionId}] ${message}`);

        log("Iniciando creación de remisión y notificaciones...");

        let emailStatus = "pending";
        let whatsappStatus = "pending";

        try {
            // 1. Generar ambos PDFs
            const pdfBuffer = generarPDF(remisionData, false);
            log("PDF de cliente generado.");
            const pdfPlantaBuffer = generarPDF(remisionData, true);
            log("PDF de planta generado.");

            // 2. Definir rutas y guardar en Firebase Storage
            const bucket = admin.storage().bucket(BUCKET_NAME);
            const filePath = `remisiones/${remisionData.numeroRemision}.pdf`;
            const file = bucket.file(filePath);
            await file.save(pdfBuffer, { metadata: { contentType: "application/pdf" } });
            log(`PDF de cliente guardado en Storage: ${filePath}`);

            const filePathPlanta = `remisiones/planta-${remisionData.numeroRemision}.pdf`;
            const filePlanta = bucket.file(filePathPlanta);
            await filePlanta.save(pdfPlantaBuffer, { metadata: { contentType: "application/pdf" } });
            log(`PDF de planta guardado en Storage: ${filePathPlanta}`);

            // 3. Actualizar Firestore con las rutas (no las URLs)
            await snap.ref.update({
                pdfPath: filePath,
                pdfPlantaPath: filePathPlanta,
            });
            log("Rutas de PDF guardadas en Firestore.");

            // 4. Enviar correo electrónico al cliente con el PDF adjunto
            try {
                const msg = {
                    to: remisionData.clienteEmail,
                    from: FROM_EMAIL,
                    subject: `Confirmación de Remisión N° ${remisionData.numeroRemision}`,
                    html: `<p>Hola ${remisionData.clienteNombre},</p><p>Hemos recibido tu orden y adjuntamos la remisión de servicio.</p><p>El estado actual es: <strong>${remisionData.estado}</strong>.</p><p>Gracias por confiar en nosotros.</p><p><strong>Importadora Vidrios Exito</strong></p>`,
                    attachments: [{
                        content: pdfBuffer.toString("base64"),
                        filename: `Remision-${remisionData.numeroRemision}.pdf`,
                        type: "application/pdf",
                        disposition: "attachment",
                    }],
                };
                await sgMail.send(msg);
                log(`Correo enviado exitosamente a ${remisionData.clienteEmail}.`);
                emailStatus = "sent";
            } catch (emailError) {
                log("Error al enviar correo:", emailError);
                emailStatus = "error";
            }

            // 5. Enviar copia para impresión
            try {
                const printerMsg = {
                    to: "oficinavidriosexito@print.brother.com",
                    from: FROM_EMAIL,
                    subject: `Nueva Remisión N° ${remisionData.numeroRemision} para Imprimir`,
                    html: `<p>Se ha generado la remisión N° ${remisionData.numeroRemision}. Adjunto para impresión.</p>`,
                    attachments: [{
                        content: pdfBuffer.toString("base64"),
                        filename: `Remision-${remisionData.numeroRemision}.pdf`,
                        type: "application/pdf",
                        disposition: "attachment",
                    }],
                };
                await sgMail.send(printerMsg);
                log(`Copia de remisión enviada a la impresora.`);
            } catch (printerError) {
                log("Error al enviar a la impresora:", printerError);
            }

            // 6. Enviar notificación por WhatsApp
            try {
                const clienteDoc = await admin.firestore().collection("clientes").doc(remisionData.idCliente).get();
                if (clienteDoc.exists) {
                    const clienteData = clienteDoc.data();
                    const telefonos = [clienteData.telefono1, clienteData.telefono2].filter(Boolean);

                    if (telefonos.length > 0) {
                        // Generar una URL temporal solo para el mensaje de WhatsApp (válida por 24 horas)
                        const [tempUrl] = await file.getSignedUrl({ action: "read", expires: Date.now() + 24 * 60 * 60 * 1000 });

                        const sendPromises = telefonos.map(telefono =>
                            sendWhatsAppRemision(
                                telefono,
                                remisionData.clienteNombre,
                                remisionData.numeroRemision.toString(),
                                remisionData.estado,
                                tempUrl // Usamos la URL temporal
                            ).catch(e => Promise.reject({ phone: telefono, error: e.message }))
                        );

                        const results = await Promise.allSettled(sendPromises);
                        let successfulSends = 0;
                        results.forEach((result, index) => {
                            if (result.status === 'fulfilled') {
                                log(`Mensaje de WhatsApp enviado exitosamente a ${telefonos[index]}.`);
                                successfulSends++;
                            } else {
                                functions.logger.error(`Falló el envío de WhatsApp a ${result.reason.phone}:`, result.reason.error);
                            }
                        });

                        if (successfulSends > 0) whatsappStatus = "sent_partial";
                        if (successfulSends === telefonos.length) whatsappStatus = "sent_all";
                        if (successfulSends === 0) whatsappStatus = "error";

                    } else {
                        log("El cliente no tiene números de teléfono registrados.");
                        whatsappStatus = "no_phone";
                    }
                } else {
                    log("No se encontró el documento del cliente para obtener el teléfono.");
                    whatsappStatus = "client_not_found";
                }
            } catch (whatsappError) {
                functions.logger.error(`Error general en el proceso de WhatsApp:`, whatsappError);
                whatsappStatus = "error";
            }

            // 7. Actualizar el estado final de las notificaciones
            return snap.ref.update({
                emailStatus: emailStatus,
                whatsappStatus: whatsappStatus,
            });

        } catch (error) {
            functions.logger.error(`[${remisionId}] Error General en onRemisionCreate:`, error);
            return snap.ref.update({
                emailStatus: "error",
                whatsappStatus: "error",
                errorLog: error.message,
            });
        }
    });

exports.onRemisionUpdate = functions.region("us-central1").firestore
    .document("remisiones/{remisionId}")
    .onUpdate(async (change, context) => {
        sgMail.setApiKey(functions.config().sendgrid.key);
        const FROM_EMAIL = functions.config().sendgrid.from_email;
        const beforeData = change.before.data();
        const afterData = change.after.data();
        const remisionId = context.params.remisionId;
        const log = (message) => {
            functions.logger.log(`[Actualización ${remisionId}] ${message}`);
        };

        const sendNotifications = async (motivo, pdfUrlToSend) => {
            try {
                const clienteDoc = await admin.firestore().collection("clientes").doc(afterData.idCliente).get();
                if (!clienteDoc.exists) {
                    log(`Cliente ${afterData.idCliente} no encontrado para notificar (${motivo}).`);
                    return;
                }

                const clienteData = clienteDoc.data();
                const telefonos = [clienteData.telefono1, clienteData.telefono2].filter(Boolean);

                if (telefonos.length === 0) {
                    log(`El cliente no tiene números para notificar (${motivo}).`);
                    return;
                }

                log(`Iniciando envío de notificaciones (${motivo}) a ${telefonos.join(", ")}`);

                const sendPromises = telefonos.map(telefono =>
                    sendWhatsAppRemision(
                        telefono,
                        afterData.clienteNombre,
                        afterData.numeroRemision.toString(),
                        afterData.estado,
                        pdfUrlToSend,
                    ).catch(e => Promise.reject({ phone: telefono, error: e.message })),
                );

                const results = await Promise.allSettled(sendPromises);
                results.forEach((result, index) => {
                    if (result.status === "fulfilled") {
                        log(`Notificación de ${motivo} enviada a ${telefonos[index]}.`);
                    } else {
                        functions.logger.error(`Falló envío de notificación (${motivo}) a ${result.reason.phone}:`, result.reason.error);
                    }
                });

            } catch (error) {
                functions.logger.error(`Error crítico en la función sendNotifications (${motivo}):`, error);
            }
        };

        // --- Gatillo para ANULACIÓN ---
        if (beforeData.estado !== "Anulada" && afterData.estado === "Anulada") {
            log("Detectada anulación. Generando PDF y enviando notificaciones.");
            try {
                const pdfBuffer = generarPDF(afterData, false);
                const pdfPlantaBuffer = generarPDF(afterData, true);
                log("PDFs de anulación generados.");

                const bucket = admin.storage().bucket(BUCKET_NAME);
                const filePath = `remisiones/${afterData.numeroRemision}.pdf`;
                const file = bucket.file(filePath);
                await file.save(pdfBuffer, { metadata: { contentType: "application/pdf" } });

                const filePathPlanta = `remisiones/planta-${afterData.numeroRemision}.pdf`;
                await bucket.file(filePathPlanta).save(pdfPlantaBuffer, { metadata: { contentType: "application/pdf" } });

                // Se guardan las rutas, no las URLs
                await change.after.ref.update({ pdfPath: filePath, pdfPlantaPath: filePathPlanta });
                log("Rutas de PDFs de anulación actualizadas en Storage y Firestore.");

                // Generar URL temporal para la notificación
                const [tempUrl] = await file.getSignedUrl({ action: "read", expires: Date.now() + 24 * 60 * 60 * 1000 }); // Válida por 24 horas

                const msg = {
                    to: afterData.clienteEmail,
                    from: FROM_EMAIL,
                    subject: `Anulación de Remisión N° ${afterData.numeroRemision}`,
                    html: `<p>Hola ${afterData.clienteNombre},</p><p>Te informamos que la remisión N° <strong>${afterData.numeroRemision}</strong> ha sido anulada.</p><p>Adjuntamos una copia del documento anulado para tus registros.</p><p><strong>Importadora Vidrios Exito</strong></p>`,
                    attachments: [{
                        content: pdfBuffer.toString("base64"),
                        filename: `Remision-ANULADA-${afterData.numeroRemision}.pdf`,
                        type: "application/pdf",
                        disposition: "attachment",
                    }],
                };
                await sgMail.send(msg);
                log(`Correo de anulación con PDF enviado a ${afterData.clienteEmail}.`);
                await sendNotifications("Anulación", tempUrl);

            } catch (error) {
                log("Error al procesar anulación:", error);
            }
        }

        // --- Gatillo para "ENTREGADO" ---
        if (beforeData.estado !== "Entregado" && afterData.estado === "Entregado") {
            log("Detectado cambio a 'Entregado'. Generando PDF y enviando notificaciones.");
            try {
                const pdfBuffer = generarPDF(afterData, false);
                log("PDF de entrega generado.");

                const bucket = admin.storage().bucket(BUCKET_NAME);
                const filePath = `remisiones/${afterData.numeroRemision}.pdf`;
                const file = bucket.file(filePath);
                await file.save(pdfBuffer, { metadata: { contentType: "application/pdf" } });

                // Se actualiza la ruta (aunque sea la misma) para asegurar consistencia
                await change.after.ref.update({ pdfPath: filePath });
                log(`PDF actualizado en Storage: ${filePath}`);

                // Generar URL temporal para la notificación
                const [tempUrl] = await file.getSignedUrl({ action: "read", expires: Date.now() + 24 * 60 * 60 * 1000 });

                const msg = {
                    to: afterData.clienteEmail,
                    from: FROM_EMAIL,
                    subject: `Tu orden N° ${afterData.numeroRemision} ha sido entregada`,
                    html: `<p>Hola ${afterData.clienteNombre},</p><p>Te informamos que tu orden N° <strong>${afterData.numeroRemision}</strong> ha sido completada y marcada como <strong>entregada</strong>.</p><p>Adjuntamos una copia final de la remisión para tus registros.</p><p>¡Gracias por tu preferencia!</p><p><strong>Importadora Vidrios Exito</strong></p>`,
                    attachments: [{
                        content: pdfBuffer.toString("base64"),
                        filename: `Remision-ENTREGADA-${afterData.numeroRemision}.pdf`,
                        type: "application/pdf",
                        disposition: "attachment",
                    }],
                };
                await sgMail.send(msg);
                log(`Correo de entrega enviado a ${afterData.clienteEmail}.`);
                await sendNotifications("Entrega", tempUrl);

            } catch (error) {
                log("Error al procesar entrega:", error);
            }
        }

        // --- Gatillo para PAGO FINAL ---
        const totalPagadoAntes = (beforeData.payments || []).filter((p) => p.status === "confirmado").reduce((sum, p) => sum + p.amount, 0);
        const totalPagadoDespues = (afterData.payments || []).filter((p) => p.status === "confirmado").reduce((sum, p) => sum + p.amount, 0);

        if (totalPagadoAntes < afterData.valorTotal && totalPagadoDespues >= afterData.valorTotal) {
            log("Detectado pago final. Generando PDF y enviando correo de confirmación.");
            try {
                const updatedRemisionData = { ...afterData, formaPago: "Cancelado" };
                const pdfBuffer = generarPDF(updatedRemisionData, false);
                log("PDF de pago final generado.");

                const bucket = admin.storage().bucket(BUCKET_NAME);
                const filePath = `remisiones/${afterData.numeroRemision}.pdf`;
                const file = bucket.file(filePath);
                await file.save(pdfBuffer, { metadata: { contentType: "application/pdf" } });

                await change.after.ref.update({ pdfPath: filePath, formaPago: "Cancelado" });
                log("Ruta del PDF y forma de pago actualizados en Firestore.");

                const ultimoPago = afterData.payments[afterData.payments.length - 1];

                const msg = {
                    to: afterData.clienteEmail,
                    from: FROM_EMAIL,
                    subject: `Confirmación de Pago Total - Remisión N° ${afterData.numeroRemision}`,
                    html: `<p>Hola ${afterData.clienteNombre},</p><p>Hemos recibido el pago final para tu remisión N° <strong>${afterData.numeroRemision}</strong>.</p><p>El valor total ha sido cancelado. Último pago registrado por ${ultimoPago.method}.</p><p>Adjuntamos la remisión actualizada para tus registros.</p><p>¡Gracias por tu confianza!</p><p><strong>Importadora Vidrios Exito</strong></p>`,
                    attachments: [{
                        content: pdfBuffer.toString("base64"),
                        filename: `Remision-CANCELADA-${afterData.numeroRemision}.pdf`,
                        type: "application/pdf",
                        disposition: "attachment",
                    }],
                };
                await sgMail.send(msg);
                log(`Correo de pago final enviado a ${afterData.clienteEmail}.`);

            } catch (error) {
                log("Error al procesar el pago final:", error);
            }
        }

        return null;
    });

// Función HTTP invocable que devuelve la configuración de Firebase del lado del cliente.
exports.getFirebaseConfig = functions.https.onCall((data, context) => {
    // Asegurarse de que el usuario esté autenticado para solicitar la configuración es una buena práctica.
    if (!context.auth) {
        throw new functions.https.HttpsError(
            "unauthenticated",
            "El usuario debe estar autenticado para solicitar la configuración."
        );
    }

    // Devuelve la configuración guardada en el entorno.
    return functions.config().prisma;
});

exports.applyDiscount = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "El usuario no está autenticado.");
    }

    const { remisionId, discountPercentage } = data;
    if (!remisionId || discountPercentage === undefined) {
        throw new functions.https.HttpsError("invalid-argument", "Faltan datos (remisionId, discountPercentage).");
    }

    if (discountPercentage < 0 || discountPercentage > 5.0001) { // Allow for small floating point inaccuracies
        throw new functions.https.HttpsError("out-of-range", "El descuento debe estar entre 0 y 5%.");
    }

    const remisionRef = admin.firestore().collection("remisiones").doc(remisionId);

    try {
        const remisionDoc = await remisionRef.get();
        const docExists = remisionDoc && (typeof remisionDoc.exists === "function" ? remisionDoc.exists() : remisionDoc.exists);
        if (!docExists) {
            throw new functions.https.HttpsError("not-found", "La remisión no existe.");
        }

        const remisionData = remisionDoc.data();
        const subtotal = remisionData.subtotal;
        const discountAmount = subtotal * (discountPercentage / 100);
        const subtotalWithDiscount = subtotal - discountAmount;
        const newIva = remisionData.incluyeIVA ? subtotalWithDiscount * 0.19 : 0;
        const newTotal = subtotalWithDiscount + newIva;

        const updatedData = {
            valorTotal: newTotal,
            valorIVA: newIva,
            discount: {
                percentage: discountPercentage,
                amount: discountAmount,
                appliedBy: context.auth.uid,
                appliedAt: new Date(),
            },
        };

        await remisionRef.update(updatedData);

        const finalRemisionData = { ...remisionData, ...updatedData };
        const pdfBuffer = generarPDF(finalRemisionData, false);
        const pdfPlantaBuffer = generarPDF(finalRemisionData, true);

        const bucket = admin.storage().bucket(BUCKET_NAME);
        const filePath = `remisiones/${finalRemisionData.numeroRemision}.pdf`;
        const file = bucket.file(filePath);
        await file.save(pdfBuffer, { metadata: { contentType: "application/pdf" } });

        const filePathPlanta = `remisiones/planta-${finalRemisionData.numeroRemision}.pdf`;
        const filePlanta = bucket.file(filePathPlanta);
        await filePlanta.save(pdfPlantaBuffer, { metadata: { contentType: "application/pdf" } });

        const [url] = await file.getSignedUrl({ action: "read", expires: "03-09-2491" });
        const [urlPlanta] = await filePlanta.getSignedUrl({ action: "read", expires: "03-09-2491" });

        await remisionRef.update({ pdfUrl: url, pdfPlantaUrl: urlPlanta });

        const msg = {
            to: finalRemisionData.clienteEmail,
            from: FROM_EMAIL,
            subject: `Descuento aplicado a tu Remisión N° ${finalRemisionData.numeroRemision}`,
            html: `<p>Hola ${finalRemisionData.clienteNombre},</p>
                   <p>Se ha aplicado un descuento del <strong>${discountPercentage.toFixed(2)}%</strong> a tu remisión N° ${finalRemisionData.numeroRemision}.</p>
                   <p>El nuevo total es: <strong>${formatCurrency(newTotal)}</strong>.</p>
                   <p>Adjuntamos la remisión actualizada.</p>
                   <p><strong>Importadora Vidrios Exito</strong></p>`,
            attachments: [{
                content: pdfBuffer.toString("base64"),
                filename: `Remision-Actualizada-${finalRemisionData.numeroRemision}.pdf`,
                type: "application/pdf",
                disposition: "attachment",
            }],
        };

        await sgMail.send(msg);

        return { success: true, message: "Descuento aplicado y correo enviado." };

    } catch (error) {
        functions.logger.error(`Error al aplicar descuento para ${remisionId}:`, error);
        throw new functions.https.HttpsError("internal", "No se pudo aplicar el descuento.");
    }
});

exports.generateRemisionPDF = functions.firestore
    .document("remisiones/{remisionId}")
    .onCreate(async (snap, context) => {
        const remisionData = snap.data();
        const remisionId = context.params.remisionId;

        try {
            const pdfDocFinal = await PDFDocument.create();
            const font = await pdfDocFinal.embedFont(StandardFonts.Helvetica);
            const fontBold = await pdfDocFinal.embedFont(StandardFonts.HelveticaBold);

            // --- PÁGINA 1: REMISIÓN DE SERVICIO (Creada con jspdf) ---
            const remisionCreator = new jsPDF();
            // Encabezado
            remisionCreator.setFont("helvetica", "bold").setFontSize(20).text("Remisión de Servicio", remisionCreator.internal.pageSize.getWidth() / 2, 20, { align: "center" });
            remisionCreator.setFont("helvetica", "normal").setFontSize(9).text("IMPORTADORA DE VIDRIOS ÉXITO | NIT: 900.284.049-3 | Tel: 311 810 9893", remisionCreator.internal.pageSize.getWidth() / 2, 28, { align: "center" });
            remisionCreator.setFontSize(16).setFont("helvetica", "bold").text(`N°: ${remisionData.numeroRemision}`, remisionCreator.internal.pageSize.getWidth() - 20, 45, { align: "right" });
            
            // Datos Remisión y Cliente
            remisionCreator.setLineWidth(0.5).line(20, 55, remisionCreator.internal.pageSize.getWidth() - 20, 55);
            remisionCreator.setFontSize(11).setFont("helvetica", "bold").text("Cliente:", 20, 65);
            remisionCreator.setFont("helvetica", "normal").text(remisionData.clienteNombre, 40, 65);
            remisionCreator.setFont("helvetica", "bold").text("Fecha Recibido:", 120, 65);
            remisionCreator.setFont("helvetica", "normal").text(remisionData.fechaRecibido, 155, 65);
            remisionCreator.setFont("helvetica", "bold").text("Fecha Entrega:", 120, 72);
            remisionCreator.setFont("helvetica", "normal").text(remisionData.fechaEntrega || 'Pendiente', 155, 72);
            remisionCreator.line(20, 80, remisionCreator.internal.pageSize.getWidth() - 20, 80);

            // Tabla de Ítems y Cargos
            const tableBody = [];
            (remisionData.items || []).forEach(item => {
                const desc = item.tipo === 'Completa' ? item.descripcion : `${item.descripcion} (Cortes según anexo)`;
                tableBody.push([item.cantidad, desc, `$ ${item.valorUnitario.toLocaleString('es-CO')}`, `$ ${item.valorTotal.toLocaleString('es-CO')}`]);
            });
            (remisionData.cargosAdicionales || []).forEach(cargo => {
                tableBody.push([1, cargo.descripcion, `$ ${cargo.valorUnitario.toLocaleString('es-CO')}`, `$ ${cargo.valorTotal.toLocaleString('es-CO')}`]);
            });
            
            remisionCreator.autoTable({ startY: 90, head: [['Cant.', 'Descripción', 'Vlr. Unit.', 'Vlr. Total']], body: tableBody, theme: 'grid' });

            // Totales y Pie de Página
            let finalY = remisionCreator.lastAutoTable.finalY + 15;
            remisionCreator.setFontSize(11).setFont("helvetica", "bold").text("Subtotal:", 130, finalY);
            remisionCreator.setFont("helvetica", "normal").text(`$ ${remisionData.subtotal.toLocaleString('es-CO')}`, 195, finalY, { align: "right" });
            remisionCreator.setFont("helvetica", "bold").text(`IVA (${remisionData.incluyeIVA ? '19%' : '0%'}):`, 130, finalY + 7);
            remisionCreator.setFont("helvetica", "normal").text(`$ ${remisionData.valorIVA.toLocaleString('es-CO')}`, 195, finalY + 7, { align: "right" });
            remisionCreator.setFont("helvetica", "bold").text("TOTAL:", 130, finalY + 14);
            remisionCreator.text(`$ ${remisionData.valorTotal.toLocaleString('es-CO')}`, 195, finalY + 14, { align: "right" });

            remisionCreator.setFontSize(8).setFont("helvetica", "bold").text("Firma y Sello de Recibido:", 20, remisionCreator.internal.pageSize.height - 30);
            remisionCreator.line(20, remisionCreator.internal.pageSize.height - 35, 100, remisionCreator.internal.pageSize.height - 35);
            remisionCreator.setFont("helvetica", "normal").setTextColor(150).text("NO SE ENTREGA TRABAJO SINO HA SIDO CANCELADO. DESPUES DE 8 DIAS NO SE RESPONDE POR MERCANCIA.", remisionCreator.internal.pageSize.getWidth() / 2, remisionCreator.internal.pageSize.height - 15, { align: 'center' });
            
            // Añadir la página creada con jspdf al documento principal
            const [remisionPage] = await pdfDocFinal.copyPages(await PDFDocument.load(remisionCreator.output('arraybuffer')), [0]);
            pdfDocFinal.addPage(remisionPage);


            // --- PÁGINAS DE PRODUCCIÓN (SI HAY CORTES) ---
            const itemsCortados = remisionData.items.filter(item => item.tipo === 'Cortada' && item.planoDespiece);
            if (itemsCortados.length > 0) {
                // --- PÁGINA 2: RESUMEN DE CORTES EN TABLA ---
                const resumenCreator = new jsPDF();
                resumenCreator.setFont("helvetica", "bold").setFontSize(18).text("Anexo de Producción: Resumen de Cortes", resumenCreator.internal.pageSize.getWidth() / 2, 20, { align: "center" });
                
                let resumenTableBody = [];
                let corteIdGlobal = 1;
                itemsCortados.forEach(item => {
                    (item.planoDespiece || []).forEach(lamina => {
                        (lamina.cortes || []).forEach(corte => {
                            resumenTableBody.push([`#${corte.id}`, item.descripcion, corte.descripcion]);
                        });
                    });
                });
                resumenCreator.autoTable({ startY: 30, head: [['ID de Corte', 'Material', 'Medida Solicitada (Ancho x Alto)']], body: resumenTableBody, theme: 'striped' });
                
                const [resumenPage] = await pdfDocFinal.copyPages(await PDFDocument.load(resumenCreator.output('arraybuffer')), [0]);
                pdfDocFinal.addPage(resumenPage);

                // --- PÁGINAS 3+: PLANOS DE DESPIECE ---
                for (const item of itemsCortados) {
                    const itemDataSnap = await db.collection('items').doc(item.itemId).get();
                    const itemData = itemDataSnap.data();
                    const anchoMaestra = itemData.ancho;
                    const altoMaestra = itemData.alto;
                    for (const lamina of item.planoDespiece) {
                        const page = pdfDocFinal.addPage();
                        page.drawText(`Plano de Corte - Lámina ${lamina.numero} de ${item.planoDespiece.length}`, { x: 50, y: 800, font: fontBold, size: 16 });
                        page.drawText(`Material: ${item.descripcion} (${anchoMaestra}x${altoMaestra}mm)`, { x: 50, y: 780, font, size: 10 });
                        
                        const escala = 500 / Math.max(anchoMaestra, altoMaestra);
                        const xOffset = 70, yOffset = 250;

                        page.drawRectangle({ x: xOffset, y: yOffset, width: anchoMaestra * escala, height: altoMaestra * escala, borderColor: rgb(0.7, 0.7, 0.7), borderWidth: 1 });
                        
                        (lamina.cortes || []).forEach(corte => {
                            page.drawRectangle({ x: xOffset + corte.x * escala, y: yOffset + corte.y * escala, width: corte.ancho * escala, height: corte.alto * escala, borderColor: rgb(0, 0, 0), borderWidth: 0.5, color: rgb(0.2, 0.6, 0.8), opacity: 0.2 });
                            const centroX = xOffset + (corte.x + corte.ancho / 2) * escala;
                            const centroY = yOffset + (corte.y + corte.alto / 2) * escala;
                            page.drawText(`#${corte.id}`, { x: centroX - 8, y: centroY + 2, font: fontBold, size: 8, color: rgb(0, 0, 0) });
                            page.drawText(corte.descripcion, { x: centroX - 15, y: centroY - 8, font, size: 6, color: rgb(0, 0, 0) });
                        });
                    }
                }
            }
            
            // --- GUARDADO FINAL ---
            const finalPdfBytes = await pdfDocFinal.save();
            const bucket = admin.storage().bucket();
            const filePath = `remisiones/${remisionId}.pdf`;
            const file = bucket.file(filePath);
            await file.save(finalPdfBytes, { contentType: 'application/pdf' });
            const pdfUrl = await file.getSignedUrl({ action: 'read', expires: '03-09-2491' }).then(urls => urls[0]);
            
            return db.collection("remisiones").doc(remisionId).update({ pdfUrl: pdfUrl });

        } catch (error) {
            console.error("Error al generar el PDF de remisión:", error);
            return null;
        }
    });



exports.onResendEmailRequest = functions.region("us-central1").firestore
    .document("resendQueue/{queueId}")
    .onCreate(async (snap, context) => {
        const request = snap.data();
        const remisionId = request.remisionId;
        const log = (message) => {
            functions.logger.log(`[Reenvío ${remisionId}] ${message}`);
        };
        log("Iniciando reenvío de correo.");

        try {
            const remisionDoc = await admin.firestore()
                .collection("remisiones").doc(remisionId).get();
            const docExists = remisionDoc && (typeof remisionDoc.exists === "function" ? remisionDoc.exists() : remisionDoc.exists);
            if (!docExists) {
                log("La remisión no existe.");
                return snap.ref.delete();
            }
            const remisionData = remisionDoc.data();

            const bucket = admin.storage().bucket(BUCKET_NAME);
            const filePath = `remisiones/${remisionData.numeroRemision}.pdf`;
            const [pdfBuffer] = await bucket.file(filePath).download();
            log("PDF descargado desde Storage.");

            const msg = {
                to: remisionData.clienteEmail,
                from: FROM_EMAIL,
                subject: `[Reenvío] Remisión N° ${remisionData.numeroRemision}`,
                html: `<p>Hola ${remisionData.clienteNombre},</p>
          <p>Como solicitaste, aquí tienes una copia de tu remisión.</p>`,
                attachments: [{
                    content: pdfBuffer.toString("base64"),
                    filename: `Remision-${remisionData.numeroRemision}.pdf`,
                    type: "application/pdf",
                    disposition: "attachment",
                }],
            };
            await sgMail.send(msg);
            log(`Correo reenviado a ${remisionData.clienteEmail}.`);

            return snap.ref.delete();
        } catch (error) {
            log("Error en el reenvío:", error);
            return snap.ref.update({ status: "error", error: error.message });
        }
    });

/**
 * NUEVA FUNCIÓN: Actualiza el documento de un empleado con la URL de un archivo.
 * Se invoca desde el cliente después de subir un archivo a Firebase Storage.
 */
exports.updateEmployeeDocument = functions.https.onCall(async (data, context) => {
    // 1. Autenticación y Verificación de Permisos
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "El usuario no está autenticado.");
    }

    const uid = context.auth.uid;
    const userDoc = await admin.firestore().collection("users").doc(uid).get();
    const userData = userDoc.data();

    if (userData.role !== "admin") {
        throw new functions.https.HttpsError("permission-denied", "El usuario no tiene permisos de administrador.");
    }

    // 2. Validación de Datos de Entrada
    const { employeeId, docType, fileUrl } = data;
    if (!employeeId || !docType || !fileUrl) {
        throw new functions.https.HttpsError("invalid-argument", "Faltan datos (employeeId, docType, fileUrl).");
    }

    // 3. Lógica de Actualización
    try {
        const employeeDocRef = admin.firestore().collection("users").doc(employeeId);

        // Usamos notación de punto para actualizar un campo dentro de un mapa.
        // Esto crea el mapa 'documentos' si no existe.
        const updatePayload = {
            [`documentos.${docType}`]: fileUrl
        };

        await employeeDocRef.update(updatePayload);

        return { success: true, message: `Documento '${docType}' actualizado para el empleado ${employeeId}.` };
    } catch (error) {
        functions.logger.error(`Error al actualizar documento para ${employeeId}:`, error);
        throw new functions.https.HttpsError("internal", "No se pudo actualizar el documento del empleado.");
    }
});

/**
 * Se activa cuando se actualiza una importación (ej. al añadir un abono).
 * Registra el abono como un gasto en COP.
 */
exports.onImportacionUpdate = functions.firestore
    .document("importaciones/{importacionId}")
    .onUpdate(async (change, context) => {
        const beforeData = change.before.data();
        const afterData = change.after.data();
        const importacionId = context.params.importacionId;
        const log = (message) => functions.logger.log(`[Imp Update ${importacionId}] ${message}`);

        const gastosAntes = beforeData.gastosNacionalizacion || {};
        const gastosDespues = afterData.gastosNacionalizacion || {};

        // Iterar sobre cada tipo de gasto (naviera, puerto, etc.)
        for (const tipoGasto of Object.keys(gastosDespues)) {
            const facturasAntes = gastosAntes[tipoGasto]?.facturas || [];
            const facturasDespues = gastosDespues[tipoGasto].facturas || [];

            // Iterar sobre cada factura de ese tipo de gasto
            facturasDespues.forEach((factura, index) => {
                const facturaAnterior = facturasAntes.find(f => f.id === factura.id);
                const abonosAntes = facturaAnterior?.abonos || [];
                const abonosDespues = factura.abonos || [];

                // Si se añadió un nuevo abono a esta factura
                if (abonosDespues.length > abonosAntes.length) {
                    const nuevoAbono = abonosDespues[abonosDespues.length - 1];
                    log(`Nuevo abono de ${nuevoAbono.valor} para factura ${factura.numeroFactura} de ${tipoGasto}`);
                    
                    const nuevoGastoDoc = {
                        fecha: nuevoAbono.fecha,
                        proveedorNombre: `${factura.proveedorNombre} (Imp. ${afterData.numeroImportacion})`,
                        proveedorId: factura.proveedorId,
                        numeroFactura: factura.numeroFactura,
                        valorTotal: nuevoAbono.valor,
                        fuentePago: nuevoAbono.formaPago,
                        registradoPor: nuevoAbono.registradoPor,
                        timestamp: new Date(),
                        isImportacionGasto: true,
                        isAbono: true,
                        importacionId: importacionId,
                        gastoTipo: tipoGasto,
                        facturaId: factura.id
                    };
                    
                    // Crear el documento en la colección de gastos
                    admin.firestore().collection("gastos").add(nuevoGastoDoc)
                        .then(() => log("Gasto por abono registrado con éxito."))
                        .catch(err => functions.logger.error("Error al registrar gasto por abono:", err));
                }
            });
        }
        return null;
    });


// Reemplaza la función setMyUserAsAdmin con esta versión más explícita
exports.setMyUserAsAdmin = functions.https.onRequest(async (req, res) => {
    // --- INICIO DE LA LÓGICA MANUAL DE PERMISOS (CORS) ---
    // Le decimos al navegador que confiamos en cualquier origen (para desarrollo)
    res.set('Access-Control-Allow-Origin', '*');

    // Manejar la solicitud de "inspección" (preflight) que hace el navegador
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.status(204).send('');
        return;
    }
    // --- FIN DE LA LÓGICA MANUAL DE PERMISOS (CORS) ---

    // El resto de la lógica para verificar y asignar el permiso de admin
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) {
        return res.status(401).send({ error: 'Unauthorized: No se proporcionó token.' });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        const userId = decodedToken.uid;
        await admin.auth().setCustomUserClaims(userId, { admin: true });
        
        console.log(`Permiso de 'admin' OTORGADO al usuario ${userId}.`);
        return res.status(200).send({ data: { message: `¡Éxito! El usuario ${userId} ahora tiene permisos de admin.` } });

    } catch (error) {
        console.error("Error al establecer permisos de administrador:", error);
        return res.status(500).send({ error: 'Error interno del servidor.' });
    }
});


    /**
 * NUEVA FUNCIÓN: Cambia el estado de un usuario (active, inactive).
 * Invocable solo por administradores.
 */
exports.setUserStatus = functions.https.onCall(async (data, context) => {
    // 1. Verificar que el que llama es un administrador
    if (!context.auth || !context.auth.token.admin) {
        throw new functions.https.HttpsError(
            "permission-denied",
            "Solo los administradores pueden cambiar el estado de un usuario."
        );
    }

    // 2. Validar los datos de entrada
    const { userId, newStatus } = data;
    if (!userId || !['active', 'inactive', 'pending'].includes(newStatus)) {
        throw new functions.https.HttpsError(
            "invalid-argument",
            "Faltan datos o el nuevo estado no es válido (userId, newStatus)."
        );
    }

    try {
        // 3. Actualizar el documento del usuario en Firestore
        const userRef = admin.firestore().collection("users").doc(userId);
        await userRef.update({ status: newStatus });

        return { success: true, message: `Estado del usuario ${userId} actualizado a ${newStatus}.` };
    } catch (error) {
        functions.logger.error(`Error al actualizar estado para ${userId}:`, error);
        throw new functions.https.HttpsError(
            "internal",
            "No se pudo actualizar el estado del usuario."
        );
    }
});
/**
 * NUEVA FUNCIÓN: Se activa cuando se escribe en un documento de usuario.
 * Sincroniza el rol de Firestore con un "custom claim" en Firebase Auth.
 * Esto permite que otras Cloud Functions verifiquen de forma segura si un usuario es admin.
 */
exports.onUserRoleChange = functions.firestore
    .document('users/{userId}')
    .onWrite(async (change, context) => {
        const userId = context.params.userId;
        const afterData = change.after.exists ? change.after.data() : null;
        const beforeData = change.before.exists ? change.before.data() : null;

        const newRole = afterData ? afterData.role : null;
        const oldRole = beforeData ? beforeData.role : null;

        // Si el rol no cambió o el usuario fue eliminado, no hacer nada.
        if (newRole === oldRole) {
            return null;
        }

        try {
            if (newRole === 'admin') {
                // Si el nuevo rol es admin, establecer la estampa de administrador.
                await admin.auth().setCustomUserClaims(userId, { admin: true });
                console.log(`Permiso de 'admin' OTORGADO al usuario ${userId}.`);
            } else if (oldRole === 'admin' && newRole !== 'admin') {
                // Si el usuario dejó de ser admin, remover la estampa.
                await admin.auth().setCustomUserClaims(userId, { admin: false });
                console.log(`Permiso de 'admin' REVOCADO al usuario ${userId}.`);
            }
        } catch (error) {
            console.error(`Error al establecer permisos para ${userId}:`, error);
        }
        return null;
    });
