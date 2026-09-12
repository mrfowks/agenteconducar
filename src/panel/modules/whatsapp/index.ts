export async function sendText(phone: string, text: string): Promise<void> {
  const formData = new FormData();
  formData.append("messaging_product", "whatsapp");
  formData.append("recipient_type", "individual");
  formData.append("to", phone);
  formData.append("type", "text");
  formData.append("text", { body: text });

  const response = await fetch(
    `https://graph.facebook.com/v17.0/${process.env.META_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to send text: ${errorText}`);
  }
}

export async function graphPost(path: string, body: any): Promise<void> {
  // In a real implementation, this would use the proper Meta Graph API credentials
  // For now, we'll use a simple fetch approach
  const formData = new FormData();
  formData.append("messaging_product", "whatsapp");
  
  if (body.to) {
    formData.append("to", body.to);
  }
  if (body.type) {
    formData.append("type", body.type);
  }
  if (body.text) {
    formData.append("text", JSON.stringify(body.text));
  }
  if (body.image) {
    formData.append("image", JSON.stringify(body.image));
  }
  if (body.caption) {
    formData.append("caption", body.caption);
  }

  const url = `https://graph.facebook.com/v17.0/${process.env.META_PHONE_NUMBER_ID}${path}`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}`,
      "Content-Type": "multipart/form-data",
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Graph API error: ${errorText}`);
  }
}